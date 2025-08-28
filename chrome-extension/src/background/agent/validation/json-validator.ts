import { z } from 'zod';
import { agentBrainSchema } from '../types';
import { buildDynamicActionSchema } from '../actions/builder';
import type { Action } from '../actions/builder';
import { createLogger } from '@src/background/log';

const logger = createLogger('JSONValidator');

/**
 * JSON Validation Worker - monitors and validates ALL AI responses
 * Ensures every response is valid JSON that matches the expected schema
 */

// Define all possible agent schemas
export const plannerSchema = z.object({
  observation: z.string(),
  done: z.boolean(),
  challenges: z.string(),
  next_steps: z.string(),
  final_answer: z.string().nullable(),
  reasoning: z.string(),
  web_task: z.union([z.boolean(), z.string()]),
});

export const navigatorSchema = z.object({
  current_state: agentBrainSchema,
  action: z.array(z.record(z.string(), z.any())),
});

export interface ValidationResult {
  isValid: boolean;
  originalResponse: string;
  parsedJson?: Record<string, unknown>;
  validatedData?: Record<string, unknown>;
  errors: string[];
  agentType: 'planner' | 'navigator' | 'unknown';
  correctedResponse?: Record<string, unknown>;
}

export class JSONValidationWorker {
  private static instance: JSONValidationWorker;
  private actionSchema: z.ZodType | null = null;

  private constructor() {}

  public static getInstance(): JSONValidationWorker {
    if (!JSONValidationWorker.instance) {
      JSONValidationWorker.instance = new JSONValidationWorker();
    }
    return JSONValidationWorker.instance;
  }

  /**
   * Set the action schema for Navigator validation
   */
  public setActionSchema(actions: Action[]): void {
    this.actionSchema = buildDynamicActionSchema(actions);
    logger.info('🔧 [JSON-VALIDATOR] Action schema updated with', actions.length, 'actions');
  }

  /**
   * Main validation method - processes any AI response
   */
  public async validateResponse(
    rawResponse: string,
    expectedType: 'planner' | 'navigator' | 'auto' = 'auto',
    context?: string,
  ): Promise<ValidationResult> {
    logger.info('🔍 [JSON-VALIDATOR] Starting validation...', {
      responseLength: rawResponse.length,
      expectedType,
      context,
    });

    const result: ValidationResult = {
      isValid: false,
      originalResponse: rawResponse,
      errors: [],
      agentType: 'unknown',
    };

    // Step 1: Detect agent type if auto
    if (expectedType === 'auto') {
      result.agentType = this.detectAgentType(rawResponse, context);
    } else {
      result.agentType = expectedType;
    }

    logger.info('🎯 [JSON-VALIDATOR] Detected agent type:', result.agentType);

    // Step 2: Extract JSON from response
    const jsonExtractionResult = this.extractJSON(rawResponse);
    if (!jsonExtractionResult.success) {
      logger.error('❌ [JSON-VALIDATOR] JSON extraction failed:', jsonExtractionResult.errors);
      result.errors.push(...jsonExtractionResult.errors);

      // Create corrected response
      result.correctedResponse = this.createFallbackResponse(result.agentType, rawResponse);
      result.validatedData = result.correctedResponse;
      result.isValid = true; // We created a valid fallback

      logger.info('✅ [JSON-VALIDATOR] Created fallback response for', result.agentType);
      return result;
    }

    result.parsedJson = jsonExtractionResult.data;

    // Step 3: Validate against schema
    if (!result.parsedJson) {
      logger.error('❌ [JSON-VALIDATOR] No parsed JSON available for schema validation');
      result.errors.push('No parsed JSON available');

      // Create corrected response
      result.correctedResponse = this.createFallbackResponse(result.agentType, rawResponse);
      result.validatedData = result.correctedResponse;
      result.isValid = true;

      return result;
    }

    const schemaValidation = this.validateAgainstSchema(result.parsedJson, result.agentType);
    if (!schemaValidation.success) {
      logger.error('❌ [JSON-VALIDATOR] Schema validation failed:', schemaValidation.errors);
      result.errors.push(...schemaValidation.errors);

      // Try to fix the JSON
      result.correctedResponse = this.fixInvalidJSON(result.parsedJson, result.agentType);
      result.validatedData = result.correctedResponse;
      result.isValid = true; // We fixed it

      logger.info('🔧 [JSON-VALIDATOR] Fixed invalid JSON for', result.agentType);
      return result;
    }

    // Step 4: Success!
    result.isValid = true;
    result.validatedData = result.parsedJson;
    logger.info('✅ [JSON-VALIDATOR] Validation successful for', result.agentType);

    return result;
  }

  /**
   * Detect which agent type based on response content and context
   */
  private detectAgentType(response: string, context?: string): 'planner' | 'navigator' {
    const lowerResponse = response.toLowerCase();
    const lowerContext = context?.toLowerCase() || '';

    // Check context first (call stack, etc.)
    if (lowerContext.includes('navigator') || lowerContext.includes('L9.')) {
      return 'navigator';
    }
    if (lowerContext.includes('planner') || lowerContext.includes('D9.')) {
      return 'planner';
    }

    // Check response content patterns
    const navigatorKeywords = [
      'current_state',
      'action',
      'evaluation_previous_goal',
      'memory',
      'next_goal',
      'click_element',
      'go_to_url',
      'input_text',
      'done',
      'navigate',
      'browser',
    ];

    const plannerKeywords = ['observation', 'challenges', 'next_steps', 'final_answer', 'reasoning', 'web_task'];

    const navigatorScore = navigatorKeywords.filter(keyword => lowerResponse.includes(keyword)).length;
    const plannerScore = plannerKeywords.filter(keyword => lowerResponse.includes(keyword)).length;

    logger.info('🎯 [JSON-VALIDATOR] Agent detection scores:', { navigatorScore, plannerScore });

    return navigatorScore > plannerScore ? 'navigator' : 'planner';
  }

  /**
   * Extract JSON from raw response with multiple strategies
   */
  private extractJSON(response: string): { success: boolean; data?: Record<string, unknown>; errors: string[] } {
    const errors: string[] = [];

    // Strategy 1: Direct JSON parse
    try {
      const trimmed = response.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const parsed = JSON.parse(trimmed);
        logger.info('✅ [JSON-VALIDATOR] Direct JSON parse successful');
        return { success: true, data: parsed, errors: [] };
      }
    } catch (e) {
      errors.push(`Direct parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Strategy 2: Extract from code blocks
    const codeBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    const codeBlockMatch = codeBlockRegex.exec(response);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1]);
        logger.info('✅ [JSON-VALIDATOR] Code block extraction successful');
        return { success: true, data: parsed, errors: [] };
      } catch (e) {
        errors.push(`Code block parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Strategy 3: Find JSON objects in text
    const jsonRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
    const matches = response.match(jsonRegex);
    if (matches) {
      for (const match of matches) {
        try {
          const parsed = JSON.parse(match);
          // Check if it looks like a valid agent response
          if (this.looksLikeAgentResponse(parsed)) {
            logger.info('✅ [JSON-VALIDATOR] Regex extraction successful');
            return { success: true, data: parsed, errors: [] };
          }
        } catch (e) {
          errors.push(`Regex match parse failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Strategy 4: Try to repair JSON
    try {
      const repairedJson = this.repairJSON(response);
      if (repairedJson) {
        logger.info('✅ [JSON-VALIDATOR] JSON repair successful');
        return { success: true, data: repairedJson, errors: [] };
      }
    } catch (e) {
      errors.push(`JSON repair failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    logger.error('❌ [JSON-VALIDATOR] All JSON extraction strategies failed');
    return { success: false, errors };
  }

  /**
   * Check if parsed object looks like an agent response
   */
  private looksLikeAgentResponse(obj: unknown): boolean {
    if (!obj || typeof obj !== 'object') return false;

    const record = obj as Record<string, unknown>;

    // Navigator indicators
    if ('current_state' in record && 'action' in record) return true;

    // Planner indicators
    if ('observation' in record && 'done' in record) return true;

    return false;
  }

  /**
   * Attempt to repair malformed JSON
   */
  private repairJSON(text: string): Record<string, unknown> | null {
    try {
      // Remove common issues
      let cleaned = text
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
        .replace(/,\s*}/g, '}') // Remove trailing commas
        .replace(/,\s*]/g, ']') // Remove trailing commas in arrays
        .replace(/'/g, '"') // Replace single quotes with double quotes
        .trim();

      // Try to find and extract JSON-like content
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');

      if (start !== -1 && end !== -1 && end > start) {
        cleaned = cleaned.substring(start, end + 1);
        return JSON.parse(cleaned);
      }
    } catch (e) {
      // Repair failed
    }

    return null;
  }

  /**
   * Validate parsed JSON against agent schema
   */
  private validateAgainstSchema(
    data: Record<string, unknown>,
    agentType: 'planner' | 'navigator',
  ): { success: boolean; errors: string[] } {
    try {
      if (agentType === 'planner') {
        plannerSchema.parse(data);
        logger.info('✅ [JSON-VALIDATOR] Planner schema validation passed');
        return { success: true, errors: [] };
      } else if (agentType === 'navigator') {
        // Create dynamic navigator schema with current actions
        const schema = z.object({
          current_state: agentBrainSchema,
          action: z.array(z.record(z.string(), z.any())), // We'll validate actions separately
        });

        schema.parse(data);
        logger.info('✅ [JSON-VALIDATOR] Navigator schema validation passed');
        return { success: true, errors: [] };
      }
    } catch (e) {
      const errors = [];
      if (e instanceof z.ZodError) {
        errors.push(...e.errors.map(err => `${err.path.join('.')}: ${err.message}`));
      } else {
        errors.push(e instanceof Error ? e.message : String(e));
      }

      logger.error('❌ [JSON-VALIDATOR] Schema validation failed:', errors);
      return { success: false, errors };
    }

    return { success: false, errors: ['Unknown agent type'] };
  }

  /**
   * Fix invalid JSON by adding missing required fields
   */
  private fixInvalidJSON(data: Record<string, unknown>, agentType: 'planner' | 'navigator'): Record<string, unknown> {
    logger.info('🔧 [JSON-VALIDATOR] Fixing invalid JSON for', agentType);

    if (agentType === 'planner') {
      return {
        observation: data.observation || 'AI response received but incomplete',
        done: data.done ?? false,
        challenges: data.challenges || '',
        next_steps: data.next_steps || 'Continue with task execution',
        final_answer: data.final_answer || '',
        reasoning: data.reasoning || 'Processing user request',
        web_task: data.web_task ?? true,
        ...data, // Preserve any existing valid fields
      };
    } else {
      return {
        current_state: data.current_state || {
          evaluation_previous_goal: 'Unknown - processing request',
          memory: 'Received AI response',
          next_goal: 'Continue task execution',
        },
        action: data.action || [
          { go_to_url: { intent: 'Navigate to requested website', url: 'https://www.google.com' } },
        ],
        ...data, // Preserve any existing valid fields
      };
    }
  }

  /**
   * Create fallback response when JSON extraction completely fails
   */
  private createFallbackResponse(
    agentType: 'planner' | 'navigator',
    originalResponse: string,
  ): Record<string, unknown> {
    logger.info('🆘 [JSON-VALIDATOR] Creating fallback response for', agentType);

    const responseSnippet = originalResponse.substring(0, 200).trim();

    if (agentType === 'planner') {
      return {
        observation: `AI returned non-JSON response: ${responseSnippet}`,
        done: false,
        challenges: 'AI model returned plain text instead of structured JSON',
        next_steps: 'Continue with task using available actions',
        final_answer: '',
        reasoning: 'Creating fallback response due to JSON parsing failure',
        web_task: true,
      };
    } else {
      return {
        current_state: {
          evaluation_previous_goal: 'Unknown - AI response was not in JSON format',
          memory: `AI response: ${responseSnippet}`,
          next_goal: 'Continue with task execution',
        },
        action: [{ go_to_url: { intent: 'Navigate as requested', url: 'https://www.google.com' } }],
      };
    }
  }

  /**
   * Validate specific action objects for Navigator
   */
  public validateActions(actions: Record<string, unknown>[]): {
    valid: boolean;
    fixedActions?: Record<string, unknown>[];
    errors: string[];
  } {
    if (!Array.isArray(actions)) {
      return {
        valid: false,
        errors: ['Actions must be an array'],
        fixedActions: [{ go_to_url: { intent: 'Navigate to website', url: 'https://www.google.com' } }],
      };
    }

    const errors: string[] = [];
    const fixedActions: Record<string, unknown>[] = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      if (!action || typeof action !== 'object') {
        errors.push(`Action ${i} is not an object`);
        fixedActions.push({ go_to_url: { intent: 'Fixed invalid action', url: 'https://www.google.com' } });
        continue;
      }

      const actionKeys = Object.keys(action);
      if (actionKeys.length !== 1) {
        errors.push(`Action ${i} should have exactly one action type`);
        fixedActions.push({ go_to_url: { intent: 'Fixed multi-key action', url: 'https://www.google.com' } });
        continue;
      }

      const actionType = actionKeys[0];
      const actionData = action[actionType];

      // Validate common action types
      if (this.isValidAction(actionType, actionData)) {
        fixedActions.push(action);
      } else {
        errors.push(`Action ${i} (${actionType}) has invalid parameters`);
        fixedActions.push(this.fixAction(actionType, actionData));
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      fixedActions: errors.length > 0 ? fixedActions : undefined,
    };
  }

  private isValidAction(actionType: string, actionData: unknown): boolean {
    if (!actionData || typeof actionData !== 'object') return false;

    const data = actionData as Record<string, unknown>;

    switch (actionType) {
      case 'go_to_url':
        return typeof data.url === 'string' && data.url.length > 0;
      case 'done':
        return typeof data.text === 'string' && typeof data.success === 'boolean';
      case 'click_element':
        return typeof data.index === 'number';
      case 'input_text':
        return typeof data.index === 'number' && typeof data.text === 'string';
      default:
        return true; // Allow unknown actions
    }
  }

  private fixAction(actionType: string, actionData: unknown): Record<string, unknown> {
    const data = actionData && typeof actionData === 'object' ? (actionData as Record<string, unknown>) : {};

    const baseAction = {
      intent: data.intent || `Execute ${actionType} action`,
    };

    switch (actionType) {
      case 'go_to_url':
        return {
          [actionType]: {
            ...baseAction,
            url: data.url || 'https://www.google.com',
          },
        };
      case 'done':
        return {
          [actionType]: {
            ...baseAction,
            text: data.text || 'Task completed',
            success: data.success ?? true,
          },
        };
      case 'click_element':
        return {
          [actionType]: {
            ...baseAction,
            index: data.index || 1,
          },
        };
      case 'input_text':
        return {
          [actionType]: {
            ...baseAction,
            index: data.index || 1,
            text: data.text || '',
          },
        };
      default:
        return {
          [actionType]: {
            ...baseAction,
            ...data,
          },
        };
    }
  }
}

// Export singleton instance
export const jsonValidator = JSONValidationWorker.getInstance();
