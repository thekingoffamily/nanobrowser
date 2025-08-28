/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt, enhancePromptForG4F } from './base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { plannerSystemPromptTemplate } from './templates/planner';
import { ProviderTypeEnum } from '@extension/storage';

export class PlannerPrompt extends BasePrompt {
  private provider?: string;

  constructor(provider?: string) {
    super();
    this.provider = provider;
  }

  getSystemMessage(): SystemMessage {
    let prompt = plannerSystemPromptTemplate;

    // Enhance prompt for G4F provider
    if (this.provider === ProviderTypeEnum.G4F) {
      console.log('🔧 [PLANNER-PROMPT] Применяем улучшенные JSON инструкции для G4F');
      prompt = enhancePromptForG4F(prompt);
    }

    return new SystemMessage(prompt);
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return new HumanMessage('');
  }
}
