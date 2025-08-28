import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { z } from 'zod';
import type { AgentOutput } from '../types';
import { HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types';
import {
  ChatModelAuthError,
  ChatModelForbiddenError,
  isAbortedError,
  isAuthenticationError,
  isForbiddenError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
} from './errors';
const logger = createLogger('PlannerAgent');

// Define Zod schema for planner output
export const plannerOutputSchema = z.object({
  observation: z.string(),
  challenges: z.string(),
  done: z.union([
    z.boolean(),
    z.string().transform(val => {
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;
      throw new Error('Invalid boolean string');
    }),
  ]),
  next_steps: z.string(),
  final_answer: z.string(),
  reasoning: z.string(),
  web_task: z.union([
    z.boolean(),
    z.string().transform(val => {
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;
      throw new Error('Invalid boolean string');
    }),
  ]),
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export class PlannerAgent extends BaseAgent<typeof plannerOutputSchema, PlannerOutput> {
  constructor(options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    super(plannerOutputSchema, options, { ...extraOptions, id: 'planner' });
  }

  async execute(): Promise<AgentOutput<PlannerOutput>> {
    console.log('📊 [PLANNER] Starting planner execution...');
    try {
      console.log('📡 [PLANNER] Emitting STEP_START event');
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_START, 'Planning...');

      // get all messages from the message manager, state message should be the last one
      const messages = this.context.messageManager.getMessages();
      console.log('📊 [PLANNER] Retrieved', messages.length, 'messages from message manager');

      // Use full message history except the first one
      const plannerMessages = [this.prompt.getSystemMessage(), ...messages.slice(1)];
      console.log('📊 [PLANNER] Prepared', plannerMessages.length, 'messages for planner');

      // Remove images from last message if vision is not enabled for planner but vision is enabled
      if (!this.context.options.useVisionForPlanner && this.context.options.useVision) {
        console.log('📊 [PLANNER] Vision disabled for planner, removing images from last message');
        const lastStateMessage = plannerMessages[plannerMessages.length - 1];
        let newMsg = '';

        if (Array.isArray(lastStateMessage.content)) {
          for (const msg of lastStateMessage.content) {
            if (msg.type === 'text') {
              newMsg += msg.text;
            }
            // Skip image_url messages
          }
        } else {
          newMsg = lastStateMessage.content;
        }

        plannerMessages[plannerMessages.length - 1] = new HumanMessage(newMsg);
        console.log('📊 [PLANNER] Images removed from last message');
      }

      console.log('📊 [PLANNER] Invoking LLM with', plannerMessages.length, 'messages...');
      const modelOutput = await this.invoke(plannerMessages);

      if (!modelOutput) {
        console.error('❌ [PLANNER] Failed to validate planner output - no output received');
        throw new Error('Failed to validate planner output');
      }

      console.log('✅ [PLANNER] Model output received successfully');
      console.log('📊 [PLANNER] Task done status:', modelOutput.done);
      console.log('📊 [PLANNER] Has final answer:', !!modelOutput.final_answer);

      // If task is done, emit the final answer; otherwise emit next steps
      const eventMessage = modelOutput.done ? modelOutput.final_answer : modelOutput.next_steps;
      console.log('📡 [PLANNER] Emitting STEP_OK event with message length:', eventMessage?.length || 0);
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, eventMessage);

      console.log('📊 [PLANNER] Full planner output:', JSON.stringify(modelOutput, null, 2));
      logger.info('Planner output', JSON.stringify(modelOutput, null, 2));

      return {
        id: this.id,
        result: modelOutput,
      };
    } catch (error) {
      console.error('❌ [PLANNER] Execution failed:', error);
      console.error('❌ [PLANNER] Execution failed:', error);
      // Check if this is an authentication error
      if (isAuthenticationError(error)) {
        console.error('❌ [PLANNER] Authentication error detected');
        throw new ChatModelAuthError('Planner API Authentication failed. Please verify your API key', error);
      }
      if (isForbiddenError(error)) {
        console.error('❌ [PLANNER] Forbidden error detected');
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      }
      if (isAbortedError(error)) {
        console.error('❌ [PLANNER] Request was cancelled');
        throw new RequestCancelledError((error as Error).message);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('❌ [PLANNER] Planning failed with error:', errorMessage);
      logger.error(`Planning failed: ${errorMessage}`);
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_FAIL, `Planning failed: ${errorMessage}`);
      return {
        id: this.id,
        error: errorMessage,
      };
    }
  }
}
