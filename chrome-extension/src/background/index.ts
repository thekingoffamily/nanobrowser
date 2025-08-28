import 'webextension-polyfill';
import {
  agentModelStore,
  AgentNameEnum,
  firewallStore,
  generalSettingsStore,
  llmProviderStore,
} from '@extension/storage';
import { t } from '@extension/i18n';
import BrowserContext from './browser/context';
import { Executor } from './agent/executor';
import { createLogger } from './log';
import { ExecutionState } from './agent/event/types';
import { createChatModel } from './agent/helper';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DEFAULT_AGENT_OPTIONS } from './agent/types';
import { SpeechToTextService } from './services/speechToText';
import { injectBuildDomTreeScripts } from './browser/dom/service';

const logger = createLogger('background');

// 🚀 STARTUP LOG
console.log('🔥 [NANOBROWSER] Extension background script starting...');
console.log('🔥 [NANOBROWSER] Logger initialized:', logger);

const browserContext = new BrowserContext({});
let currentExecutor: Executor | null = null;
let currentPort: chrome.runtime.Port | null = null;

console.log('🔥 [NANOBROWSER] Browser context initialized:', browserContext);

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => {
  console.error('❌ [NANOBROWSER] Failed to setup side panel:', error);
  logger.error('Failed to setup side panel:', error);
});

console.log('✅ [NANOBROWSER] Side panel behavior configured');

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    console.log(`🌐 [NANOBROWSER] Tab updated - injecting scripts to tab ${tabId}, URL: ${tab.url}`);
    await injectBuildDomTreeScripts(tabId);
    console.log(`✅ [NANOBROWSER] Scripts injected to tab ${tabId}`);
  }
});

// Listen for debugger detached event
// if canceled_by_user, remove the tab from the browser context
chrome.debugger.onDetach.addListener(async (source, reason) => {
  console.log('Debugger detached:', source, reason);
  if (reason === 'canceled_by_user') {
    if (source.tabId) {
      currentExecutor?.cancel();
      await browserContext.cleanup();
    }
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  browserContext.removeAttachedPage(tabId);
});

logger.info('background loaded');

// Listen for simple messages (e.g., from options page)
chrome.runtime.onMessage.addListener(() => {
  // Handle other message types if needed in the future
  // Return false if response is not sent asynchronously
  // return false;
});

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  console.log('🔌 [NANOBROWSER] Port connection attempt:', port.name);
  logger.info('Port connection attempt:', port.name);

  if (port.name === 'side-panel-connection') {
    currentPort = port;
    console.log('✅ [NANOBROWSER] Side panel port established successfully');
    logger.info('Side panel port established successfully');

    port.onMessage.addListener(async message => {
      console.log('📨 [NANOBROWSER] Received message from side panel:', message.type, message);
      logger.info('Received message from side panel:', message);

      try {
        switch (message.type) {
          case 'heartbeat':
            console.log('💓 [NANOBROWSER] Heartbeat received');
            // Acknowledge heartbeat
            port.postMessage({ type: 'heartbeat_ack' });
            console.log('💓 [NANOBROWSER] Heartbeat acknowledged');
            break;

          case 'new_task': {
            console.log('🚀 [NANOBROWSER] Starting NEW TASK:', message.task);
            logger.info('Starting new task:', message.task, 'tabId:', message.tabId);

            if (!message.task) {
              console.error('❌ [NANOBROWSER] No task provided');
              return port.postMessage({ type: 'error', error: t('bg_cmd_newTask_noTask') });
            }
            if (!message.tabId) {
              console.error('❌ [NANOBROWSER] No tab ID provided');
              return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            }

            // 🔒 [TASK-VALIDATION] Prevent infinite loops on empty pages
            const trimmedTask = message.task.trim();
            if (trimmedTask.length < 3) {
              console.error('❌ [NANOBROWSER] Task too short, potential infinite loop risk:', trimmedTask);
              return port.postMessage({
                type: 'error',
                error: 'Task is too short. Please provide a meaningful instruction (at least 3 characters).',
              });
            }

            // Check for suspicious "navigation request" patterns that could cause loops
            const suspiciousPatterns = [
              /^navigate\s*$/i,
              /^go\s*$/i,
              /^открой\s*$/i,
              /^navigate as requested\s*$/i,
              /^выполни\s*$/i,
            ];

            if (suspiciousPatterns.some(pattern => pattern.test(trimmedTask))) {
              console.error(
                '❌ [NANOBROWSER] Suspicious task pattern detected, preventing potential infinite loop:',
                trimmedTask,
              );
              return port.postMessage({
                type: 'error',
                error:
                  'Please provide a specific task instead of generic navigation request. Example: "open google.com" or "search for weather"',
              });
            }

            console.log('✅ [NANOBROWSER] Task validation passed:', trimmedTask);

            console.log('🔧 [NANOBROWSER] Setting up executor...');
            currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
            console.log('✅ [NANOBROWSER] Executor setup complete');

            console.log('📡 [NANOBROWSER] Subscribing to executor events...');
            subscribeToExecutorEvents(currentExecutor);
            console.log('✅ [NANOBROWSER] Event subscription complete');

            console.log('🎯 [NANOBROWSER] Executing task...');
            const result = await currentExecutor.execute();
            console.log('✅ [NANOBROWSER] Task execution completed:', result);
            logger.info('new_task execution result', message.tabId, result);
            break;
          }

          case 'follow_up_task': {
            console.log('🔄 [NANOBROWSER] Starting FOLLOW-UP TASK:', message.task);
            logger.info('Starting follow-up task:', message.task, 'tabId:', message.tabId);

            if (!message.task) {
              console.error('❌ [NANOBROWSER] No follow-up task provided');
              return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_noTask') });
            }
            if (!message.tabId) {
              console.error('❌ [NANOBROWSER] No tab ID provided for follow-up task');
              return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            }

            // If executor exists, add follow-up task
            if (currentExecutor) {
              console.log('➕ [NANOBROWSER] Adding follow-up task to existing executor');
              currentExecutor.addFollowUpTask(message.task);
              // Re-subscribe to events in case the previous subscription was cleaned up
              console.log('📡 [NANOBROWSER] Re-subscribing to executor events');
              subscribeToExecutorEvents(currentExecutor);
              console.log('🎯 [NANOBROWSER] Executing follow-up task...');
              const result = await currentExecutor.execute();
              console.log('✅ [NANOBROWSER] Follow-up task execution completed:', result);
              logger.info('follow_up_task execution result', message.tabId, result);
            } else {
              // executor was cleaned up, can not add follow-up task
              console.error('❌ [NANOBROWSER] No executor available for follow-up task - was cleaned up');
              logger.info('follow_up_task: executor was cleaned up, can not add follow-up task');
              return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_cleaned') });
            }
            break;
          }

          case 'cancel_task': {
            console.log('❌ [NANOBROWSER] Cancelling task...');
            if (!currentExecutor) {
              console.error('❌ [NANOBROWSER] No running task to cancel');
              return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            }
            await currentExecutor.cancel();
            console.log('✅ [NANOBROWSER] Task cancelled successfully');
            break;
          }

          case 'resume_task': {
            console.log('▶️ [NANOBROWSER] Resuming task...');
            if (!currentExecutor) {
              console.error('❌ [NANOBROWSER] No task to resume');
              return port.postMessage({ type: 'error', error: t('bg_cmd_resumeTask_noTask') });
            }
            await currentExecutor.resume();
            console.log('✅ [NANOBROWSER] Task resumed successfully');
            return port.postMessage({ type: 'success' });
          }

          case 'pause_task': {
            console.log('⏸️ [NANOBROWSER] Pausing task...');
            if (!currentExecutor) {
              console.error('❌ [NANOBROWSER] No running task to pause');
              return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            }
            await currentExecutor.pause();
            console.log('✅ [NANOBROWSER] Task paused successfully');
            return port.postMessage({ type: 'success' });
          }

          case 'screenshot': {
            console.log('📷 [NANOBROWSER] Taking screenshot for tab:', message.tabId);
            if (!message.tabId) {
              console.error('❌ [NANOBROWSER] No tab ID provided for screenshot');
              return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            }
            const page = await browserContext.switchTab(message.tabId);
            console.log('📷 [NANOBROWSER] Switched to tab, taking screenshot...');
            const screenshot = await page.takeScreenshot();
            console.log('✅ [NANOBROWSER] Screenshot taken successfully');
            logger.info('screenshot', message.tabId, screenshot);
            return port.postMessage({ type: 'success', screenshot });
          }

          case 'state': {
            console.log('📊 [NANOBROWSER] Getting browser state...');
            try {
              const browserState = await browserContext.getState(true);
              const elementsText = browserState.elementTree.clickableElementsToString(
                DEFAULT_AGENT_OPTIONS.includeAttributes,
              );

              console.log('✅ [NANOBROWSER] Browser state retrieved successfully');
              console.log('🔍 [NANOBROWSER] Interactive elements retrieved successfully');
              logger.info('state', browserState);
              logger.info('interactive elements', elementsText);
              return port.postMessage({ type: 'success', msg: t('bg_cmd_state_printed') });
            } catch (error) {
              console.error('❌ [NANOBROWSER] Failed to get browser state:', error);
              logger.error('Failed to get state:', error);
              return port.postMessage({ type: 'error', error: t('bg_cmd_state_failed') });
            }
          }

          case 'nohighlight': {
            const page = await browserContext.getCurrentPage();
            await page.removeHighlight();
            return port.postMessage({ type: 'success', msg: t('bg_cmd_nohighlight_ok') });
          }

          case 'speech_to_text': {
            try {
              if (!message.audio) {
                return port.postMessage({
                  type: 'speech_to_text_error',
                  error: t('bg_cmd_stt_noAudioData'),
                });
              }

              logger.info('Processing speech-to-text request...');

              // Get all providers for speech-to-text service
              const providers = await llmProviderStore.getAllProviders();

              // Create speech-to-text service with all providers
              const speechToTextService = await SpeechToTextService.create(providers);

              // Extract base64 audio data (remove data URL prefix if present)
              let base64Audio = message.audio;
              if (base64Audio.startsWith('data:')) {
                base64Audio = base64Audio.split(',')[1];
              }

              // Transcribe audio
              const transcribedText = await speechToTextService.transcribeAudio(base64Audio);

              logger.info('Speech-to-text completed successfully');
              return port.postMessage({
                type: 'speech_to_text_result',
                text: transcribedText,
              });
            } catch (error) {
              logger.error('Speech-to-text failed:', error);
              return port.postMessage({
                type: 'speech_to_text_error',
                error: error instanceof Error ? error.message : t('bg_cmd_stt_failed'),
              });
            }
          }

          case 'replay': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });
            if (!message.historySessionId)
              return port.postMessage({ type: 'error', error: t('bg_cmd_replay_noHistory') });
            logger.info('replay', message.tabId, message.taskId, message.historySessionId);

            try {
              // Switch to the specified tab
              await browserContext.switchTab(message.tabId);
              // Setup executor with the new taskId and a dummy task description
              currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
              subscribeToExecutorEvents(currentExecutor);

              // Run replayHistory with the history session ID
              const result = await currentExecutor.replayHistory(message.historySessionId);
              logger.debug('replay execution result', message.tabId, result);
            } catch (error) {
              logger.error('Replay failed:', error);
              return port.postMessage({
                type: 'error',
                error: error instanceof Error ? error.message : t('bg_cmd_replay_failed'),
              });
            }
            break;
          }

          default:
            return port.postMessage({ type: 'error', error: t('errors_cmd_unknown', [message.type]) });
        }
      } catch (error) {
        console.error('Error handling port message:', error);
        port.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : t('errors_unknown'),
        });
      }
    });

    port.onDisconnect.addListener(() => {
      // this event is also triggered when the side panel is closed, so we need to cancel the task
      console.log('Side panel disconnected');
      currentPort = null;
      currentExecutor?.cancel();
    });
  }
});

async function setupExecutor(taskId: string, task: string, browserContext: BrowserContext) {
  console.log('🔧 [NANOBROWSER] Setting up executor for task:', task);
  console.log('🔧 [NANOBROWSER] Task ID:', taskId);

  const providers = await llmProviderStore.getAllProviders();
  console.log('📊 [NANOBROWSER] Loaded providers:', Object.keys(providers));

  // if no providers, need to display the options page
  if (Object.keys(providers).length === 0) {
    console.error('❌ [NANOBROWSER] No API keys configured');
    throw new Error(t('bg_setup_noApiKeys'));
  }

  // Clean up any legacy validator settings for backward compatibility
  console.log('🧩 [NANOBROWSER] Cleaning up legacy validator settings...');
  await agentModelStore.cleanupLegacyValidatorSettings();

  const agentModels = await agentModelStore.getAllAgentModels();
  console.log('🤖 [NANOBROWSER] Loaded agent models:', agentModels);

  // verify if every provider used in the agent models exists in the providers
  for (const agentModel of Object.values(agentModels)) {
    if (!providers[agentModel.provider]) {
      console.error('❌ [NANOBROWSER] Provider not found:', agentModel.provider);
      throw new Error(t('bg_setup_noProvider', [agentModel.provider]));
    }
  }

  const navigatorModel = agentModels[AgentNameEnum.Navigator];
  if (!navigatorModel) {
    console.error('❌ [NANOBROWSER] Navigator model not configured');
    throw new Error(t('bg_setup_noNavigatorModel'));
  }

  // Log the provider config being used for the navigator
  const navigatorProviderConfig = providers[navigatorModel.provider];
  console.log('🦭 [NANOBROWSER] Navigator using provider:', navigatorModel.provider, navigatorProviderConfig?.name);
  const navigatorLLM = createChatModel(navigatorProviderConfig, navigatorModel);
  console.log('✅ [NANOBROWSER] Navigator LLM created successfully');

  let plannerLLM: BaseChatModel | null = null;
  const plannerModel = agentModels[AgentNameEnum.Planner];
  if (plannerModel) {
    // Log the provider config being used for the planner
    const plannerProviderConfig = providers[plannerModel.provider];
    console.log('📊 [NANOBROWSER] Planner using provider:', plannerModel.provider, plannerProviderConfig?.name);
    plannerLLM = createChatModel(plannerProviderConfig, plannerModel);
    console.log('✅ [NANOBROWSER] Planner LLM created successfully');
  } else {
    console.log('📊 [NANOBROWSER] No planner model configured - using navigator LLM');
  }

  // Apply firewall settings to browser context
  const firewall = await firewallStore.getFirewall();
  console.log('🔥 [NANOBROWSER] Firewall settings:', firewall);
  if (firewall.enabled) {
    console.log(
      '🔥 [NANOBROWSER] Applying firewall with allowed URLs:',
      firewall.allowList.length,
      'denied URLs:',
      firewall.denyList.length,
    );
    browserContext.updateConfig({
      allowedUrls: firewall.allowList,
      deniedUrls: firewall.denyList,
    });
  } else {
    console.log('🔥 [NANOBROWSER] Firewall disabled');
    browserContext.updateConfig({
      allowedUrls: [],
      deniedUrls: [],
    });
  }

  const generalSettings = await generalSettingsStore.getSettings();
  console.log('⚙️ [NANOBROWSER] General settings:', generalSettings);
  browserContext.updateConfig({
    minimumWaitPageLoadTime: generalSettings.minWaitPageLoad / 1000.0,
    displayHighlights: generalSettings.displayHighlights,
  });

  console.log('🔨 [NANOBROWSER] Creating executor with settings...');
  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    navigatorProvider: navigatorModel.provider,
    plannerProvider: plannerModel?.provider || navigatorModel.provider,
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      maxFailures: generalSettings.maxFailures,
      maxActionsPerStep: generalSettings.maxActionsPerStep,
      useVision: generalSettings.useVision,
      useVisionForPlanner: true,
      planningInterval: generalSettings.planningInterval,
    },
    generalSettings: generalSettings,
  });

  console.log('✅ [NANOBROWSER] Executor created successfully');
  return executor;
}

// Update subscribeToExecutorEvents to use port
async function subscribeToExecutorEvents(executor: Executor) {
  console.log('📡 [NANOBROWSER] Setting up executor event subscription...');

  // Clear previous event listeners to prevent multiple subscriptions
  executor.clearExecutionEvents();
  console.log('🧩 [NANOBROWSER] Cleared previous event listeners');

  // Subscribe to new events
  executor.subscribeExecutionEvents(async event => {
    console.log('📡 [NANOBROWSER] Executor event received:', event.actor, event.state);

    try {
      if (currentPort) {
        currentPort.postMessage(event);
        console.log('📡 [NANOBROWSER] Event sent to side panel:', event.state);
      } else {
        console.warn('⚠️ [NANOBROWSER] No port available to send event');
      }
    } catch (error) {
      console.error('❌ [NANOBROWSER] Failed to send event to side panel:', error);
      logger.error('Failed to send message to side panel:', error);
    }

    if (
      event.state === ExecutionState.TASK_OK ||
      event.state === ExecutionState.TASK_FAIL ||
      event.state === ExecutionState.TASK_CANCEL
    ) {
      console.log('🏁 [NANOBROWSER] Task completed, cleaning up executor...');
      await currentExecutor?.cleanup();
      currentExecutor = null; // Очищаем ссылку для предотвращения утечек памяти
      console.log('✅ [NANOBROWSER] Executor cleanup completed');
    }
  });

  console.log('✅ [NANOBROWSER] Event subscription set up successfully');
}
