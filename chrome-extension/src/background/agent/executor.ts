import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
} from './agents/errors';
import { wrapUntrustedContent } from './messages/utils';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig } from '@extension/storage';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  navigatorProvider?: string;
  plannerProvider?: string;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  // 🔄 [LOOP-DETECTION] Track execution state to prevent infinite loops
  private lastPlannerOutput: string | null = null;
  private repetitiveActionCount = 0;
  private readonly MAX_REPETITIVE_ACTIONS = 3;
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    console.log('🔨 [EXECUTOR] Creating new executor instance...');
    console.log('🔨 [EXECUTOR] Task:', task);
    console.log('🔨 [EXECUTOR] Task ID:', taskId);

    const messageManager = new MessageManager();
    console.log('📨 [EXECUTOR] Message manager created');

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    console.log('📡 [EXECUTOR] Event manager created');

    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );
    console.log('🧪 [EXECUTOR] Agent context created');

    this.generalSettings = extraArgs?.generalSettings;
    this.tasks.push(task);
    console.log('🎯 [EXECUTOR] Task added to queue:', this.tasks.length, 'total tasks');

    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep, extraArgs?.navigatorProvider);
    this.plannerPrompt = new PlannerPrompt(extraArgs?.plannerProvider);
    console.log('📜 [EXECUTOR] Prompts initialized with provider info');
    console.log('📜 [EXECUTOR] Navigator provider:', extraArgs?.navigatorProvider);
    console.log('📜 [EXECUTOR] Planner provider:', extraArgs?.plannerProvider);

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());
    console.log('🔨 [EXECUTOR] Action registry built with', Object.keys(navigatorActionRegistry).length, 'actions');

    // Initialize agents with their respective prompts
    console.log('🦭 [EXECUTOR] Creating Navigator agent...');
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
      provider: extraArgs?.navigatorProvider || '',
    });
    console.log('✅ [EXECUTOR] Navigator agent created');

    console.log('📊 [EXECUTOR] Creating Planner agent...');
    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
      provider: extraArgs?.plannerProvider || '',
    });
    console.log('✅ [EXECUTOR] Planner agent created');

    this.context = context;
    // Initialize message history
    console.log('📨 [EXECUTOR] Initializing message history...');
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
    console.log('✅ [EXECUTOR] Executor initialization complete');
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    console.log('📊 [EXECUTOR] Starting planner execution...');
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        console.log('📊 [EXECUTOR] Adding browser state to memory...');
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
        console.log('📊 [EXECUTOR] Browser state added at position:', positionForPlan);
      } else {
        positionForPlan = this.context.messageManager.length();
        console.log('📊 [EXECUTOR] Using position for plan:', positionForPlan);
      }

      // Execute planner
      console.log('📊 [EXECUTOR] Executing planner...');
      const planOutput = await this.planner.execute();
      console.log('📊 [EXECUTOR] Planner execution completed, success:', !!planOutput.result);

      if (planOutput.result) {
        console.log('📊 [EXECUTOR] Processing planner result...');

        // 🔄 [LOOP-DETECTION] Check for repetitive planner outputs
        const currentPlannerOutput = planOutput.result.next_steps || planOutput.result.observation || '';
        if (this.lastPlannerOutput && this.lastPlannerOutput === currentPlannerOutput) {
          this.repetitiveActionCount++;
          console.warn(
            `⚠️ [EXECUTOR] Repetitive planner output detected (${this.repetitiveActionCount}/${this.MAX_REPETITIVE_ACTIONS}):`,
            currentPlannerOutput.substring(0, 100),
          );

          if (this.repetitiveActionCount >= this.MAX_REPETITIVE_ACTIONS) {
            console.error('❌ [EXECUTOR] Maximum repetitive actions reached, stopping to prevent infinite loop');
            // Force task completion to break the loop
            const forceCompletionPlan: PlannerOutput = {
              observation: 'Detected repetitive behavior - completing task to prevent infinite loop',
              done: true,
              challenges: 'System detected potential infinite loop',
              next_steps: 'Task completed due to loop prevention',
              final_answer: 'Task stopped to prevent infinite execution loop',
              reasoning: 'Loop detection mechanism activated',
              web_task: true,
            };
            this.context.messageManager.addPlan(JSON.stringify(forceCompletionPlan), positionForPlan);
            return { result: forceCompletionPlan, error: null };
          }
        } else {
          // Reset counter if output is different
          this.repetitiveActionCount = 0;
          this.lastPlannerOutput = currentPlannerOutput;
        }
        // Store plan in message history
        const observation = wrapUntrustedContent(planOutput.result.observation);
        const plan: PlannerOutput = {
          ...planOutput.result,
          observation,
        };
        this.context.messageManager.addPlan(JSON.stringify(plan), positionForPlan);
        console.log('📊 [EXECUTOR] Plan stored in message history');
        console.log('📊 [EXECUTOR] Plan done status:', plan.done);
      }

      return planOutput;
    } catch (error) {
      console.error('❌ [EXECUTOR] Planner execution failed:', error);
      logger.error('Planner execution failed:', error);
      return null;
    }
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      console.log('✅ [EXECUTOR] Planner confirms task completion');
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        console.log('💬 [EXECUTOR] Final answer provided:', planOutput.result.final_answer.substring(0, 100) + '...');
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    const currentTask = this.tasks[this.tasks.length - 1];
    console.log('🚀 [EXECUTOR] Starting task execution:', currentTask);
    logger.info(`🚀 Executing task: ${currentTask}`);

    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;
    console.log('🔢 [EXECUTOR] Max steps allowed:', allowedMaxSteps);

    try {
      console.log('📡 [EXECUTOR] Emitting TASK_START event');
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        console.log(`🔄 [EXECUTOR] === STEP ${step + 1} / ${allowedMaxSteps} ===`);
        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);

        if (await this.shouldStop()) {
          console.log('⏹️ [EXECUTOR] Stop condition met, breaking execution loop');
          break;
        }

        // Run planner periodically for guidance
        if (this.planner && (context.nSteps % context.options.planningInterval === 0 || navigatorDone)) {
          console.log(
            '📊 [EXECUTOR] Running planner (interval:',
            context.options.planningInterval,
            'steps:',
            context.nSteps,
            'navigatorDone:',
            navigatorDone,
            ')',
          );
          navigatorDone = false;
          latestPlanOutput = await this.runPlanner();

          // Check if task is complete after planner run
          if (this.checkTaskCompletion(latestPlanOutput)) {
            console.log('✅ [EXECUTOR] Task marked as complete by planner');
            break;
          }
        }

        // Execute navigator
        console.log('🦭 [EXECUTOR] Running navigator...');
        navigatorDone = await this.navigate();
        console.log('🦭 [EXECUTOR] Navigator completed, done:', navigatorDone);

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          console.log('🔄 [EXECUTOR] Navigator indicates completion - will be validated by next planner run');
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true;
      console.log('🏁 [EXECUTOR] Task execution loop completed');
      console.log('🏁 [EXECUTOR] Steps executed:', step);
      console.log('🏁 [EXECUTOR] Task completed:', isCompleted);
      console.log('🏁 [EXECUTOR] Final answer available:', !!latestPlanOutput?.result?.final_answer);

      if (isCompleted) {
        console.log('✅ [EXECUTOR] Task completed successfully');
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);
      } else if (step >= allowedMaxSteps) {
        console.log('❌ [EXECUTOR] Task failed: Max steps reached');
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));
      } else if (this.context.stopped) {
        console.log('🛑 [EXECUTOR] Task was stopped by user');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
      } else {
        console.log('⏸️ [EXECUTOR] Task was paused');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
      }
    } catch (error) {
      console.error('❌ [EXECUTOR] Task execution failed:', error);
      if (error instanceof RequestCancelledError) {
        console.log('🛑 [EXECUTOR] Task was cancelled');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('❌ [EXECUTOR] Task failed with error:', errorMessage);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));
      }
    } finally {
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get current browser state before navigation to detect changes
      const beforeState = await context.browserContext.getCachedState();
      const beforeUrl = beforeState?.url || '';

      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }

      // 🔄 [PROGRESS-DETECTION] Check if we actually made progress
      const afterState = await context.browserContext.getCachedState();
      const afterUrl = afterState?.url || '';

      if (beforeUrl === afterUrl && beforeUrl !== '' && !navOutput.result?.done) {
        console.warn(
          `⚠️ [EXECUTOR] No URL change detected after navigation step. Before: ${beforeUrl}, After: ${afterUrl}`,
        );
        // Still count as a step but note the lack of progress
      } else if (beforeUrl !== afterUrl) {
        console.log(`✅ [EXECUTOR] Navigation progress detected: ${beforeUrl} → ${afterUrl}`);
        // Reset repetitive counter on successful navigation
        this.repetitiveActionCount = 0;
      }

      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new Error(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
