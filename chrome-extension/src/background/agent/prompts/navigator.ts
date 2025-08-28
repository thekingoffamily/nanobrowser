/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt, enhanceNavigatorPromptForG4F } from './base';
import { type HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { createLogger } from '@src/background/log';
import { navigatorSystemPromptTemplate } from './templates/navigator';
import { ProviderTypeEnum } from '@extension/storage';

const logger = createLogger('agent/prompts/navigator');

export class NavigatorPrompt extends BasePrompt {
  private systemMessage: SystemMessage;
  private provider?: string;

  constructor(
    private readonly maxActionsPerStep = 10,
    provider?: string,
  ) {
    super();
    this.provider = provider;

    const promptTemplate = navigatorSystemPromptTemplate;
    // Format the template with the maxActionsPerStep
    let formattedPrompt = promptTemplate.replace('{{max_actions}}', this.maxActionsPerStep.toString()).trim();

    // Enhance prompt for G4F provider
    if (this.provider === ProviderTypeEnum.G4F) {
      console.log('🔧 [NAVIGATOR-PROMPT] Применяем улучшенные JSON инструкции для G4F');
      formattedPrompt = enhanceNavigatorPromptForG4F(formattedPrompt);
    }

    this.systemMessage = new SystemMessage(formattedPrompt);
  }

  getSystemMessage(): SystemMessage {
    /**
     * Get the system prompt for the agent.
     *
     * @returns SystemMessage containing the formatted system prompt
     */
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return await this.buildBrowserStateUserMessage(context);
  }
}
