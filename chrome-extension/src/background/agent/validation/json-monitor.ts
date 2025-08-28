import { createLogger } from '@src/background/log';
import { jsonValidator, type ValidationResult } from './json-validator';

const logger = createLogger('JSONMonitor');

/**
 * JSON Response Monitor - Real-time monitoring of ALL AI responses
 * This worker monitors every response from AI models and ensures JSON validity
 */
export class JSONResponseMonitor {
  private static instance: JSONResponseMonitor;
  private responseCount = 0;
  private successCount = 0;
  private correctionCount = 0;
  private failureCount = 0;
  private monitoringActive = true;

  private constructor() {
    console.log('🔍 [JSON-MONITOR] JSON Response Monitor initialized');
    console.log('🔍 [JSON-MONITOR] Will monitor ALL AI responses for JSON validity');
  }

  public static getInstance(): JSONResponseMonitor {
    if (!JSONResponseMonitor.instance) {
      JSONResponseMonitor.instance = new JSONResponseMonitor();
    }
    return JSONResponseMonitor.instance;
  }

  /**
   * Monitor and validate AI response in real-time
   */
  public async monitorResponse(
    response: string,
    agentType: 'planner' | 'navigator' | 'auto' = 'auto',
    context?: string,
  ): Promise<ValidationResult> {
    if (!this.monitoringActive) {
      console.log('⏸️ [JSON-MONITOR] Monitoring is disabled, skipping validation');
      return this.createBypassResult(response);
    }

    this.responseCount++;
    const responseId = `R${this.responseCount.toString().padStart(4, '0')}`;

    console.log(`🔍 [JSON-MONITOR] === MONITORING RESPONSE ${responseId} ===`);
    console.log(`🔍 [JSON-MONITOR] Agent Type: ${agentType}`);
    console.log(`🔍 [JSON-MONITOR] Context: ${context || 'None'}`);
    console.log(`🔍 [JSON-MONITOR] Response Length: ${response.length} characters`);
    console.log(
      `🔍 [JSON-MONITOR] Response Preview: ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`,
    );

    try {
      // Use the JSON validator for comprehensive validation
      const validationResult = await jsonValidator.validateResponse(response, agentType, context);

      // Log validation results
      if (validationResult.isValid) {
        if (validationResult.correctedResponse) {
          this.correctionCount++;
          console.log(`✅ [JSON-MONITOR] ${responseId} - Response CORRECTED and validated successfully`);
          console.log(`🔧 [JSON-MONITOR] ${responseId} - Corrections applied:`, validationResult.errors);
        } else {
          this.successCount++;
          console.log(`✅ [JSON-MONITOR] ${responseId} - Response validated successfully (no corrections needed)`);
        }
      } else {
        this.failureCount++;
        console.error(`❌ [JSON-MONITOR] ${responseId} - Response validation FAILED`);
        console.error(`❌ [JSON-MONITOR] ${responseId} - Errors:`, validationResult.errors);
      }

      // Log statistics
      this.logStatistics();

      // Additional validation checks
      this.performAdditionalChecks(validationResult, responseId);

      return validationResult;
    } catch (error) {
      this.failureCount++;
      console.error(`💥 [JSON-MONITOR] ${responseId} - Monitor crashed:`, error);
      logger.error(`JSON Monitor crashed for response ${responseId}:`, error);

      // Create emergency fallback
      return this.createEmergencyResult(response, agentType, error);
    }
  }

  /**
   * Perform additional validation checks
   */
  private performAdditionalChecks(result: ValidationResult, responseId: string): void {
    if (!result.validatedData) {
      console.warn(`⚠️ [JSON-MONITOR] ${responseId} - No validated data available`);
      return;
    }

    // Check for Navigator-specific issues
    if (result.agentType === 'navigator') {
      this.validateNavigatorResponse(result.validatedData, responseId);
    }

    // Check for Planner-specific issues
    if (result.agentType === 'planner') {
      this.validatePlannerResponse(result.validatedData, responseId);
    }

    // Check for common issues
    this.validateCommonIssues(result.validatedData, responseId);
  }

  /**
   * Validate Navigator-specific requirements
   */
  private validateNavigatorResponse(data: Record<string, unknown>, responseId: string): void {
    console.log(`🦭 [JSON-MONITOR] ${responseId} - Validating Navigator response structure...`);

    if (!data.current_state) {
      console.error(`❌ [JSON-MONITOR] ${responseId} - Navigator missing current_state`);
    } else {
      const state = data.current_state as Record<string, unknown>;
      if (!state.evaluation_previous_goal || !state.memory || !state.next_goal) {
        console.warn(`⚠️ [JSON-MONITOR] ${responseId} - Navigator current_state missing required fields`);
      }
    }

    if (!data.action || !Array.isArray(data.action)) {
      console.error(`❌ [JSON-MONITOR] ${responseId} - Navigator missing or invalid action array`);
    } else {
      console.log(`✅ [JSON-MONITOR] ${responseId} - Navigator has ${data.action.length} actions`);

      // Validate each action
      data.action.forEach((action, index) => {
        this.validateAction(action, index, responseId);
      });
    }
  }

  /**
   * Validate individual action structure
   */
  private validateAction(action: unknown, index: number, responseId: string): void {
    if (!action || typeof action !== 'object') {
      console.error(`❌ [JSON-MONITOR] ${responseId} - Action ${index} is not an object:`, action);
      return;
    }

    const actionRecord = action as Record<string, unknown>;
    const actionKeys = Object.keys(actionRecord);
    if (actionKeys.length !== 1) {
      console.warn(`⚠️ [JSON-MONITOR] ${responseId} - Action ${index} should have exactly one key, found:`, actionKeys);
      return;
    }

    const actionType = actionKeys[0];
    const actionData = actionRecord[actionType];

    console.log(`🎯 [JSON-MONITOR] ${responseId} - Action ${index}: ${actionType}`);

    // Validate common action patterns
    if (!actionData || typeof actionData !== 'object') {
      console.error(`❌ [JSON-MONITOR] ${responseId} - Action ${index} (${actionType}) data is invalid:`, actionData);
      return;
    }

    const data = actionData as Record<string, unknown>;

    // Check for required intent parameter
    if (!data.intent) {
      console.warn(`⚠️ [JSON-MONITOR] ${responseId} - Action ${index} (${actionType}) missing 'intent' parameter`);
    }

    // Validate specific action types
    switch (actionType) {
      case 'go_to_url':
        if (!data.url || typeof data.url !== 'string') {
          console.error(`❌ [JSON-MONITOR] ${responseId} - go_to_url action missing valid URL:`, data.url);
        }
        break;
      case 'done':
        if (!data.text || typeof data.success !== 'boolean') {
          console.error(`❌ [JSON-MONITOR] ${responseId} - done action missing text or success:`, data);
        }
        break;
      case 'click_element':
        if (typeof data.index !== 'number') {
          console.error(`❌ [JSON-MONITOR] ${responseId} - click_element action missing valid index:`, data.index);
        }
        break;
    }
  }

  /**
   * Validate Planner-specific requirements
   */
  private validatePlannerResponse(data: Record<string, unknown>, responseId: string): void {
    console.log(`📊 [JSON-MONITOR] ${responseId} - Validating Planner response structure...`);

    const requiredFields = ['observation', 'done', 'challenges', 'next_steps', 'final_answer', 'reasoning', 'web_task'];
    const missingFields: string[] = [];

    requiredFields.forEach(field => {
      if (!(field in data)) {
        missingFields.push(field);
      }
    });

    if (missingFields.length > 0) {
      console.error(`❌ [JSON-MONITOR] ${responseId} - Planner missing required fields:`, missingFields);
    } else {
      console.log(`✅ [JSON-MONITOR] ${responseId} - Planner has all required fields`);
    }

    // Type validation
    if (typeof data.done !== 'boolean') {
      console.warn(`⚠️ [JSON-MONITOR] ${responseId} - Planner 'done' should be boolean, got:`, typeof data.done);
    }

    if (data.final_answer !== null && typeof data.final_answer !== 'string') {
      console.warn(
        `⚠️ [JSON-MONITOR] ${responseId} - Planner 'final_answer' should be string or null, got:`,
        typeof data.final_answer,
      );
    }
  }

  /**
   * Validate common issues across all agent types
   */
  private validateCommonIssues(data: Record<string, unknown>, responseId: string): void {
    // Check for circular references
    try {
      JSON.stringify(data);
    } catch (error) {
      console.error(`❌ [JSON-MONITOR] ${responseId} - Data contains circular references or other JSON issues:`, error);
    }

    // Check for suspicious values
    Object.entries(data).forEach(([key, value]) => {
      if (value === undefined) {
        console.warn(`⚠️ [JSON-MONITOR] ${responseId} - Property '${key}' is undefined (should be null or omitted)`);
      }
      if (typeof value === 'string' && value.trim() === '') {
        console.warn(`⚠️ [JSON-MONITOR] ${responseId} - Property '${key}' is empty string`);
      }
    });
  }

  /**
   * Log monitoring statistics
   */
  private logStatistics(): void {
    const totalResponses = this.responseCount;
    const successRate = totalResponses > 0 ? ((this.successCount / totalResponses) * 100).toFixed(1) : '0.0';
    const correctionRate = totalResponses > 0 ? ((this.correctionCount / totalResponses) * 100).toFixed(1) : '0.0';
    const failureRate = totalResponses > 0 ? ((this.failureCount / totalResponses) * 100).toFixed(1) : '0.0';

    console.log(
      `📊 [JSON-MONITOR] STATISTICS - Total: ${totalResponses}, Success: ${this.successCount} (${successRate}%), Corrected: ${this.correctionCount} (${correctionRate}%), Failed: ${this.failureCount} (${failureRate}%)`,
    );
  }

  /**
   * Create bypass result when monitoring is disabled
   */
  private createBypassResult(response: string): ValidationResult {
    return {
      isValid: true,
      originalResponse: response,
      agentType: 'unknown',
      errors: [],
      validatedData: { bypass: true },
    };
  }

  /**
   * Create emergency result when monitor crashes
   */
  private createEmergencyResult(
    response: string,
    agentType: 'planner' | 'navigator' | 'auto',
    error: unknown,
  ): ValidationResult {
    console.log(`🆘 [JSON-MONITOR] Creating emergency result for crashed monitor`);

    const detectedType = agentType === 'auto' ? 'navigator' : agentType;

    return {
      isValid: true,
      originalResponse: response,
      agentType: detectedType,
      errors: [`Monitor crashed: ${error instanceof Error ? error.message : String(error)}`],
      correctedResponse: this.createEmergencyFallback(detectedType, response),
    };
  }

  /**
   * Create emergency fallback when monitor fails
   */
  private createEmergencyFallback(agentType: 'planner' | 'navigator', response: string): Record<string, unknown> {
    if (agentType === 'planner') {
      return {
        observation: `Monitor emergency fallback - original response: ${response.substring(0, 100)}`,
        done: false,
        challenges: 'JSON monitoring system crashed',
        next_steps: 'Continue with emergency procedures',
        final_answer: '',
        reasoning: 'Emergency fallback due to monitor failure',
        web_task: true,
      };
    } else {
      return {
        current_state: {
          evaluation_previous_goal: 'Monitor emergency fallback',
          memory: `Monitor crashed, original response: ${response.substring(0, 100)}`,
          next_goal: 'Execute emergency action',
        },
        action: [{ go_to_url: { intent: 'Emergency navigation to safe page', url: 'https://www.google.com' } }],
      };
    }
  }

  /**
   * Enable/disable monitoring
   */
  public setMonitoring(enabled: boolean): void {
    this.monitoringActive = enabled;
    console.log(`🔧 [JSON-MONITOR] Monitoring ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Get monitoring statistics
   */
  public getStatistics() {
    return {
      totalResponses: this.responseCount,
      successCount: this.successCount,
      correctionCount: this.correctionCount,
      failureCount: this.failureCount,
      successRate: this.responseCount > 0 ? (this.successCount / this.responseCount) * 100 : 0,
      correctionRate: this.responseCount > 0 ? (this.correctionCount / this.responseCount) * 100 : 0,
      failureRate: this.responseCount > 0 ? (this.failureCount / this.responseCount) * 100 : 0,
    };
  }

  /**
   * Reset statistics
   */
  public resetStatistics(): void {
    this.responseCount = 0;
    this.successCount = 0;
    this.correctionCount = 0;
    this.failureCount = 0;
    console.log('🔄 [JSON-MONITOR] Statistics reset');
  }
}

// Export singleton instance
export const jsonMonitor = JSONResponseMonitor.getInstance();
