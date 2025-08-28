import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext, AgentOutput } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { BaseMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { Action } from '../actions/builder';
import { convertInputMessages, removeThinkTags } from '../messages/utils';
import { jsonMonitor } from '../validation/json-monitor';
import { isAbortedError } from './errors';
import { ProviderTypeEnum } from '@extension/storage';
import type { z } from 'zod';

const logger = createLogger('agent');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallOptions = Record<string, any>;

// Update options to use Zod schema
export interface BaseAgentOptions {
  chatLLM: BaseChatModel;
  context: AgentContext;
  prompt: BasePrompt;
  provider?: string;
}
export interface ExtraAgentOptions {
  id?: string;
  toolCallingMethod?: string;
  callOptions?: CallOptions;
}

/**
 * Base class for all agents
 * @param T - The Zod schema for the model output
 * @param M - The type of the result field of the agent output
 */
export abstract class BaseAgent<T extends z.ZodType, M = unknown> {
  protected id: string;
  protected chatLLM: BaseChatModel;
  protected prompt: BasePrompt;
  protected context: AgentContext;
  protected actions: Record<string, Action> = {};
  protected modelOutputSchema: T;
  protected toolCallingMethod: string | null;
  protected chatModelLibrary: string;
  protected modelName: string;
  protected provider: string;
  protected withStructuredOutput: boolean;
  protected callOptions?: CallOptions;
  protected modelOutputToolName: string;
  declare ModelOutput: z.infer<T>;

  constructor(modelOutputSchema: T, options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    // base options
    this.modelOutputSchema = modelOutputSchema;
    this.chatLLM = options.chatLLM;
    this.prompt = options.prompt;
    this.context = options.context;
    this.provider = options.provider || '';
    // TODO: fix this, the name is not correct in production environment
    this.chatModelLibrary = this.chatLLM.constructor.name;
    this.modelName = this.getModelName();
    this.withStructuredOutput = this.setWithStructuredOutput();
    // extra options
    this.id = extraOptions?.id || 'agent';
    this.toolCallingMethod = this.setToolCallingMethod(extraOptions?.toolCallingMethod);
    this.callOptions = extraOptions?.callOptions;
    this.modelOutputToolName = `${this.id}_output`;
  }

  // Set the model name
  private getModelName(): string {
    if ('modelName' in this.chatLLM) {
      return this.chatLLM.modelName as string;
    }
    if ('model_name' in this.chatLLM) {
      return this.chatLLM.model_name as string;
    }
    if ('model' in this.chatLLM) {
      return this.chatLLM.model as string;
    }
    return 'Unknown';
  }

  // Set the tool calling method
  private setToolCallingMethod(toolCallingMethod?: string): string | null {
    if (toolCallingMethod === 'auto') {
      switch (this.chatModelLibrary) {
        case 'ChatGoogleGenerativeAI':
          return null;
        case 'ChatOpenAI':
        case 'AzureChatOpenAI':
        case 'ChatGroq':
        case 'ChatXAI':
          return 'function_calling';
        default:
          return null;
      }
    }
    return toolCallingMethod || null;
  }

  // Check if model is a Llama model (only for Llama-specific handling)
  private isLlamaModel(modelName: string): boolean {
    return modelName.includes('Llama-4') || modelName.includes('Llama-3.3') || modelName.includes('llama-3.3');
  }

  // Set whether to use structured output based on the model name
  private setWithStructuredOutput(): boolean {
    if (this.modelName === 'deepseek-reasoner' || this.modelName === 'deepseek-r1') {
      return false;
    }

    // G4F provider often has issues with structured output, use manual JSON extraction
    if (this.provider === ProviderTypeEnum.G4F) {
      console.log(`🔧 [API-CONFIG] G4F провайдер - используется ручное извлечение JSON для модели: ${this.modelName}`);
      logger.debug(
        `[${this.modelName}] G4F provider doesn't reliably support structured output, using manual JSON extraction`,
      );
      return false;
    }

    // Llama API models don't support json_schema response format
    if (this.provider === ProviderTypeEnum.Llama || this.isLlamaModel(this.modelName)) {
      logger.debug(`[${this.modelName}] Llama API doesn't support structured output, using manual JSON extraction`);
      return false;
    }

    return true;
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // 📤 [API-OUT] Подробное логирование запроса к LLM
    console.log('📤 [API-OUT] ===== ОТПРАВКА ЗАПРОСА К LLM =====');
    console.log('📤 [API-OUT] Модель:', this.modelName);
    console.log('📤 [API-OUT] Провайдер:', this.provider);
    console.log('📤 [API-OUT] Библиотека:', this.chatModelLibrary);
    console.log('📤 [API-OUT] Structured Output:', this.withStructuredOutput);
    console.log('📤 [API-OUT] Количество сообщений:', inputMessages.length);

    // Логируем каждое сообщение в запросе
    inputMessages.forEach((message, index) => {
      console.log(`📤 [API-OUT] Сообщение ${index + 1}:`);
      console.log(`📤 [API-OUT]   Роль: ${message.constructor.name}`);

      if (typeof message.content === 'string') {
        const content = message.content;
        console.log(
          `📤 [API-OUT]   Контент (${content.length} символов):`,
          content.length > 1000 ? content.substring(0, 1000) + '...[ОБРЕЗАНО]' : content,
        );
      } else if (Array.isArray(message.content)) {
        console.log(`📤 [API-OUT]   Контент (массив из ${message.content.length} элементов):`);
        message.content.forEach((item, itemIndex) => {
          if (item.type === 'text') {
            console.log(
              `📤 [API-OUT]     [${itemIndex}] Текст (${item.text.length} символов):`,
              item.text.length > 500 ? item.text.substring(0, 500) + '...[ОБРЕЗАНО]' : item.text,
            );
          } else if (item.type === 'image_url') {
            console.log(`📤 [API-OUT]     [${itemIndex}] Изображение:`, item.image_url?.url?.substring(0, 100) + '...');
          } else {
            console.log(`📤 [API-OUT]     [${itemIndex}] ${item.type}:`, item);
          }
        });
      }
    });

    const startTime = Date.now();

    // Use structured output
    if (this.withStructuredOutput) {
      console.log('📤 [API-OUT] Используется структурированный вывод с схемой:', this.modelOutputToolName);

      logger.debug(`[${this.modelName}] Preparing structured output call with schema:`, {
        schemaName: this.modelOutputToolName,
        messageCount: inputMessages.length,
        modelProvider: this.provider,
      });

      const structuredLlm = this.chatLLM.withStructuredOutput(this.modelOutputSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      try {
        console.log('📤 [API-OUT] Вызов LLM...');
        logger.debug(`[${this.modelName}] Invoking LLM with structured output...`);
        const response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });

        const endTime = Date.now();
        const duration = endTime - startTime;

        // 📥 [API-IN] Подробное логирование ответа от LLM
        console.log('📥 [API-IN] ===== ПОЛУЧЕН ОТВЕТ ОТ LLM =====');
        console.log('📥 [API-IN] Модель:', this.modelName);
        console.log('📥 [API-IN] Время выполнения:', duration, 'мс');
        console.log('📥 [API-IN] Есть parsed:', !!response.parsed);
        console.log('📥 [API-IN] Есть raw:', !!response.raw);

        if (response.raw?.content) {
          const rawContent =
            typeof response.raw.content === 'string' ? response.raw.content : JSON.stringify(response.raw.content);
          console.log(
            '📥 [API-IN] Raw контент (',
            rawContent.length,
            'символов):',
            rawContent.length > 2000 ? rawContent.substring(0, 2000) + '...[ОБРЕЗАНО]' : rawContent,
          );
        }

        if (response.parsed) {
          console.log('📥 [API-IN] Parsed результат:', JSON.stringify(response.parsed, null, 2));
        }

        logger.debug(`[${this.modelName}] LLM response received:`, {
          hasParsed: !!response.parsed,
          hasRaw: !!response.raw,
          rawContent: response.raw?.content?.slice(0, 500) + (response.raw?.content?.length > 500 ? '...' : ''),
        });

        if (response.parsed) {
          console.log('✅ [API-IN] Успешно распарсен структурированный вывод');
          logger.debug(`[${this.modelName}] Successfully parsed structured output`);
          return response.parsed;
        }
        console.error('❌ [API-IN] Не удалось распарсить ответ:', response);
        logger.error('Failed to parse response', response);
        throw new Error('Could not parse response with structured output');
      } catch (error) {
        const endTime = Date.now();
        const duration = endTime - startTime;

        console.error('❌ [API-IN] ОШИБКА ВЫЗОВА LLM (', duration, 'мс):', error);

        if (isAbortedError(error)) {
          console.error('❌ [API-IN] Запрос был отменен');
          throw error;
        }

        // Для G4F провайдера пробуем fallback на ручное извлечение JSON
        if (this.provider === ProviderTypeEnum.G4F) {
          console.warn('⚠️ [API-IN] Structured output не сработал для G4F, переключаемся на ручное извлечение...');
          logger.warning(`[${this.modelName}] Structured output failed for G4F, switching to manual JSON extraction`);

          // Переключаемся на ручной режим (ВАЖНО: избегаем рекурсии)
          this.withStructuredOutput = false;

          // Не вызываем invoke повторно - вместо этого продолжаем с ручным извлечением
          console.log('📤 [API-OUT] Продолжаем с ручным извлечением JSON для G4F...');
          // Логика ручного извлечения будет выполнена ниже
        } else {
          console.error('❌ [API-IN] Ошибка вызова LLM:', error);
          logger.error(`[${this.modelName}] LLM call failed with error:`, error);
          const errorMessage = `Failed to invoke ${this.modelName} with structured output: ${error}`;
          throw new Error(errorMessage);
        }
      }
    }

    // Without structured output support, need to extract JSON from model output manually
    console.log('📤 [API-OUT] Используется ручное извлечение JSON (фолбэк)');
    logger.debug(`[${this.modelName}] Using manual JSON extraction fallback method`);
    const convertedInputMessages = convertInputMessages(inputMessages, this.modelName);

    console.log('📤 [API-OUT] Конвертация сообщений для модели завершена');

    try {
      console.log('📤 [API-OUT] Вызов LLM (ручной режим)...');
      const response = await this.chatLLM.invoke(convertedInputMessages, {
        signal: this.context.controller.signal,
        ...this.callOptions,
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log('📥 [API-IN] ===== ОТВЕТ ОТ LLM (РУЧНОЙ РЕЖИМ) =====');
      console.log('📥 [API-IN] Модель:', this.modelName);
      console.log('📥 [API-IN] Время выполнения:', duration, 'мс');
      console.log('📥 [API-IN] Тип контента:', typeof response.content);

      if (typeof response.content === 'string') {
        console.log(
          '📥 [API-IN] Контент (строка, ',
          response.content.length,
          ' символов):',
          response.content.length > 2000 ? response.content.substring(0, 2000) + '...[ОБРЕЗАНО]' : response.content,
        );

        const cleanedContent = removeThinkTags(response.content);
        if (cleanedContent !== response.content) {
          console.log(
            '🧩 [API-IN] Удалены think теги, очищенный контент:',
            cleanedContent.length > 1000 ? cleanedContent.substring(0, 1000) + '...[ОБРЕЗАНО]' : cleanedContent,
          );
        }

        response.content = cleanedContent;

        try {
          console.log('🔍 [API-IN] Запуск JSON монитора и валидатора...');
          // Use JSON Monitor for comprehensive real-time validation
          const agentType = this.id === 'navigator' ? 'navigator' : 'planner';
          const monitorResult = await jsonMonitor.monitorResponse(
            response.content,
            agentType,
            `Agent: ${this.id}, Model: ${this.modelName}, Provider: ${this.provider}`,
          );

          console.log('📊 [API-IN] Результат мониторинга:', {
            isValid: monitorResult.isValid,
            agentType: monitorResult.agentType,
            hasErrors: monitorResult.errors.length > 0,
            hasCorrectedResponse: !!monitorResult.correctedResponse,
          });

          if (monitorResult.errors && monitorResult.errors.length > 0) {
            console.warn('⚠️ [API-IN] Ошибки мониторинга:', monitorResult.errors);
          }

          // Use monitored and validated data (either original or corrected)
          const finalJson = monitorResult.validatedData || monitorResult.correctedResponse || monitorResult.parsedJson;
          if (finalJson) {
            console.log('✅ [API-IN] Финальный JSON после мониторинга:', JSON.stringify(finalJson, null, 2));

            // Final validation against the model schema
            console.log('🔍 [API-IN] Окончательная валидация модели...');
            const parsed = this.validateModelOutput(finalJson);
            if (parsed) {
              console.log('✅ [API-IN] Модель вывода прошла окончательную валидацию:', JSON.stringify(parsed, null, 2));
              return parsed;
            }
          } else {
            console.error('❌ [API-IN] Нет валидных данных после мониторинга');
          }
        } catch (error) {
          console.error('❌ [API-IN] Ошибка мониторинга JSON:', error);
          logger.error(`[${this.modelName}] JSON monitoring failed:`, error);

          // Ultimate fallback - create a basic valid response
          console.log('🆘 [API-IN] Создание аварийного fallback ответа...');
          const agentType = this.id === 'navigator' ? 'navigator' : 'planner';
          const fallbackResponse = this.createEmergencyFallback(agentType, response.content);

          console.log('🔧 [API-IN] Аварийный fallback создан:', JSON.stringify(fallbackResponse, null, 2));
          const parsed = this.validateModelOutput(fallbackResponse);
          if (parsed) {
            console.log('✅ [API-IN] Аварийный fallback успешно валидирован');
            return parsed;
          }

          const errorMessage = `Complete JSON monitoring failure for ${this.modelName}: ${error}`;
          throw new Error(errorMessage);
        }
      } else {
        console.log('📥 [API-IN] Контент (не строка):', response.content);
      }
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      console.error('❌ [API-IN] Ошибка вызова LLM в ручном режиме (', duration, 'мс):', error);
      logger.error(`[${this.modelName}] LLM call failed in manual extraction mode:`, error);
      throw error;
    }

    const errorMessage = `Failed to parse response from ${this.modelName}`;
    console.error('❌ [API-IN] Не удалось распарсить ответ:', errorMessage);
    logger.error(errorMessage);
    throw new Error('Could not parse response');
  }

  // Execute the agent and return the result
  abstract execute(): Promise<AgentOutput<M>>;

  // Helper method to validate metadata
  protected validateModelOutput(data: unknown): this['ModelOutput'] | undefined {
    if (!this.modelOutputSchema || !data) return undefined;
    try {
      return this.modelOutputSchema.parse(data);
    } catch (error) {
      logger.error('validateModelOutput', error);
      throw new Error('Could not validate model output');
    }
  }

  // Emergency fallback when all validation fails
  protected createEmergencyFallback(
    agentType: 'navigator' | 'planner',
    originalResponse: string,
  ): Record<string, unknown> {
    console.log('🆘 [EMERGENCY] Creating emergency fallback for', agentType);

    const responseSnippet = originalResponse.substring(0, 150).trim();

    // 🔒 Enhanced safety check - ensure we have a valid, safe URL
    const safeUrl = 'https://www.google.com/';

    // Check if we're on an empty or problematic page
    let isEmptyOrProblematic = false;
    this.context.browserContext
      .getCachedState()
      .then(state => {
        isEmptyOrProblematic =
          !state?.url ||
          state.url === 'about:blank' ||
          state.url === 'chrome://newtab/' ||
          state.url === 'edge://newtab/' ||
          state.url.startsWith('chrome://') ||
          state.url.startsWith('edge://') ||
          state.url.startsWith('moz-extension://') ||
          state.url.startsWith('chrome-extension://');
        console.log(
          `🔍 [EMERGENCY] Current browser state: URL=${state?.url}, Empty/Problematic: ${isEmptyOrProblematic}`,
        );
      })
      .catch(err => {
        console.error('❌ [EMERGENCY] Failed to get browser state:', err);
        isEmptyOrProblematic = true; // Assume problematic if we can't check
      });

    if (agentType === 'planner') {
      return {
        observation: `JSON parsing failed: ${responseSnippet}. Providing safe navigation plan.`,
        done: false,
        challenges: 'Model output was not properly formatted JSON',
        next_steps: 'Navigate to Google as a safe, universal starting point for any web tasks',
        final_answer: '',
        reasoning: 'Google provides a safe, reliable platform for web navigation and search tasks',
        web_task: true,
      };
    } else {
      // Navigator fallback - provide specific navigation action
      return {
        current_state: {
          evaluation_previous_goal: 'JSON parsing failed, need safe navigation',
          memory: `Previous response was malformed: ${responseSnippet.substring(0, 50)}...`,
          next_goal: 'Navigate to Google as safe starting point',
        },
        action: [
          {
            go_to_url: {
              intent: 'Navigate to Google as safe fallback after JSON parsing failure',
              url: safeUrl,
            },
          },
        ],
      };
    }
  }
}
