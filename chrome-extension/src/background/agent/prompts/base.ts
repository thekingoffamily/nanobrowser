import { HumanMessage, type SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { wrapUntrustedContent } from '../messages/utils';
import { createLogger } from '@src/background/log';

const logger = createLogger('BasePrompt');

/**
 * Helper function to add G4F-specific JSON instructions to a prompt
 */
export function enhancePromptForG4F(prompt: string): string {
  const g4fEnhancement = `

=== CRITICAL JSON RESPONSE RULES FOR G4F MODELS ===

**IMPORTANT**: You MUST respond with ONLY valid JSON. No explanations, no additional text.

**JSON TEMPLATE**: Always follow this EXACT format:
\`\`\`json
{
  "observation": "[your observation here]",
  "done": false,
  "challenges": "[challenges if any]",
  "next_steps": "[next steps]",
  "final_answer": null,
  "reasoning": "[your reasoning]",
  "web_task": true
}
\`\`\`

**FIELD REQUIREMENTS**:
- observation: string (required) - what you observed
- done: boolean (required) - true/false, is task complete?
- challenges: string (required) - any challenges, use "" if none
- next_steps: string (required) - what to do next
- final_answer: string or null (required) - answer if done, null if not
- reasoning: string (required) - your reasoning process
- web_task: boolean (required) - true for web tasks, false for general questions

**RULES**:
1. Start response with { and end with }
2. Use double quotes for all strings
3. Boolean values: true/false (not "true"/"false")
4. null values: null (not "null")
5. NO extra text before or after JSON
6. NO explanations like "Here's the JSON" or "I understand"
7. ALL fields are required - don't skip any
8. If unsure, copy the template exactly and fill in values

**EXAMPLE FOR WEB TASK**:
{"observation": "User wants to open a website", "done": false, "challenges": "", "next_steps": "Navigate to the requested website", "final_answer": null, "reasoning": "This is a simple web navigation task", "web_task": true}

**EXAMPLE BAD RESPONSE** (DO NOT DO THIS):
I understand the task. Here's my response:
{"observation": "...", "done": false}

=== END JSON RULES ===
`;

  return prompt + g4fEnhancement;
}

/**
 * Helper function to add G4F-specific JSON instructions for Navigator
 */
export function enhanceNavigatorPromptForG4F(prompt: string): string {
  const g4fEnhancement = `

=== CRITICAL JSON RESPONSE RULES FOR G4F MODELS ===

**IMPORTANT**: You MUST respond with ONLY valid JSON. No explanations, no additional text.

**JSON TEMPLATE**: Always follow this EXACT format:
\`\`\`json
{
  "current_state": {
    "evaluation_previous_goal": "Success|Failed|Unknown - [brief evaluation]",
    "memory": "[what has been done and what to remember]",
    "next_goal": "[what needs to be done next]"
  },
  "action": [{"action_name": {"parameter": "value"}}]
}
\`\`\`

**AVAILABLE ACTIONS**:
- {"go_to_url": {"intent": "Navigate to website", "url": "https://example.com"}} - Navigate to URL
- {"done": {"text": "Task completed", "success": true}} - Mark task as complete
- {"click_element": {"intent": "Click button", "index": 5}} - Click on element
- {"input_text": {"intent": "Fill form", "index": 3, "text": "search query"}} - Type text
- {"search_google": {"intent": "Search on Google", "query": "search terms"}} - Google search

**SPECIFIC EXAMPLES**:
- For empty tabs, use: {"go_to_url": {"intent": "Navigate to Google as universal starting point", "url": "https://www.google.com"}}
- For any research task: {"go_to_url": {"intent": "Navigate to Google for search", "url": "https://www.google.com"}}
- For specific services: {"go_to_url": {"intent": "Navigate directly to service", "url": "https://www.speedtest.net"}}
- For Google search: {"search_google": {"intent": "Search for information", "query": "internet speed test online"}}

**RULES**:
1. Start response with { and end with }
2. Use double quotes for all strings
3. NO extra text before or after JSON
4. NO explanations like "Here's the JSON" or "I understand"
5. action array must contain valid action objects from the list above
6. For opening websites, use go_to_url action with intent and URL
7. ALL actions require an 'intent' parameter describing the purpose
8. If unsure, copy the template exactly and fill in values

**EXAMPLE FOR OPENING A WEBSITE**:
{"current_state": {"evaluation_previous_goal": "Unknown", "memory": "User wants to open a website", "next_goal": "Navigate to the website"}, "action": [{"go_to_url": {"intent": "Open requested website", "url": "https://example.com"}}]}

**EXAMPLE FOR ANY REQUEST FROM EMPTY TAB**:
{"current_state": {"evaluation_previous_goal": "Empty tab detected", "memory": "Starting from empty tab, need to begin with universal platform", "next_goal": "Go to Google for flexible foundation"}, "action": [{"go_to_url": {"intent": "Navigate to Google as universal starting point", "url": "https://www.google.com"}}]}

**EXAMPLE FOR SPEED TEST (AFTER GOOGLE)**:
{"current_state": {"evaluation_previous_goal": "On Google", "memory": "Need to find speed test service", "next_goal": "Search for speed test or go directly"}, "action": [{"go_to_url": {"intent": "Open speed test website", "url": "https://www.speedtest.net"}}]}

=== END JSON RULES ===
`;

  return prompt + g4fEnhancement;
}
/**
 * Abstract base class for all prompt types
 */
abstract class BasePrompt {
  /**
   * Returns the system message that defines the AI's role and behavior
   * @returns SystemMessage from LangChain
   */
  abstract getSystemMessage(): SystemMessage;

  /**
   * Returns the user message for the specific prompt type
   * @param context - Optional context data needed for generating the user message
   * @returns HumanMessage from LangChain
   */
  abstract getUserMessage(context: AgentContext): Promise<HumanMessage>;

  /**
   * Builds the user message containing the browser state
   * @param context - The agent context
   * @returns HumanMessage from LangChain
   */
  async buildBrowserStateUserMessage(context: AgentContext): Promise<HumanMessage> {
    const browserState = await context.browserContext.getState(context.options.useVision);
    const rawElementsText = browserState.elementTree.clickableElementsToString(context.options.includeAttributes);

    let formattedElementsText = '';
    if (rawElementsText !== '') {
      const scrollInfo = `[Scroll info of current page] window.scrollY: ${browserState.scrollY}, document.body.scrollHeight: ${browserState.scrollHeight}, window.visualViewport.height: ${browserState.visualViewportHeight}, visual viewport height as percentage of scrollable distance: ${Math.round((browserState.visualViewportHeight / (browserState.scrollHeight - browserState.visualViewportHeight)) * 100)}%\n`;
      logger.info(scrollInfo);
      const elementsText = wrapUntrustedContent(rawElementsText);
      formattedElementsText = `${scrollInfo}[Start of page]\n${elementsText}\n[End of page]\n`;
    } else {
      formattedElementsText = 'empty page';
    }

    let stepInfoDescription = '';
    if (context.stepInfo) {
      stepInfoDescription = `Current step: ${context.stepInfo.stepNumber + 1}/${context.stepInfo.maxSteps}`;
    }

    const timeStr = new Date().toISOString().slice(0, 16).replace('T', ' '); // Format: YYYY-MM-DD HH:mm
    stepInfoDescription += `Current date and time: ${timeStr}`;

    let actionResultsDescription = '';
    if (context.actionResults.length > 0) {
      for (let i = 0; i < context.actionResults.length; i++) {
        const result = context.actionResults[i];
        if (result.extractedContent) {
          actionResultsDescription += `\nAction result ${i + 1}/${context.actionResults.length}: ${result.extractedContent}`;
        }
        if (result.error) {
          // only use last line of error
          const error = result.error.split('\n').pop();
          actionResultsDescription += `\nAction error ${i + 1}/${context.actionResults.length}: ...${error}`;
        }
      }
    }

    const currentTab = `{id: ${browserState.tabId}, url: ${browserState.url}, title: ${browserState.title}}`;
    const otherTabs = browserState.tabs
      .filter(tab => tab.id !== browserState.tabId)
      .map(tab => `- {id: ${tab.id}, url: ${tab.url}, title: ${tab.title}}`);
    const stateDescription = `
[Task history memory ends]
[Current state starts here]
The following is one-time information - if you need to remember it write it to memory:
Current tab: ${currentTab}
Other available tabs:
  ${otherTabs.join('\n')}
Interactive elements from top layer of the current page inside the viewport:
${formattedElementsText}
${stepInfoDescription}
${actionResultsDescription}
`;

    if (browserState.screenshot && context.options.useVision) {
      return new HumanMessage({
        content: [
          { type: 'text', text: stateDescription },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${browserState.screenshot}` },
          },
        ],
      });
    }

    return new HumanMessage(stateDescription);
  }
}

export { BasePrompt };
