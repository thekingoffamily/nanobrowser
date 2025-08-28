import { ChatMessage, Actors } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';

/**
 * Форматирует историю чата в текстовый формат
 * @param messages Список сообщений чата
 * @returns Отформатированная история чата в виде текста
 */
export function formatChatHistory(messages: ChatMessage[]): string {
  if (!messages || messages.length === 0) {
    return 'Нет истории чата';
  }

  const formattedMessages = messages.map(message => {
    const actor = ACTOR_PROFILES[message.actor as keyof typeof ACTOR_PROFILES];
    const actorName = actor?.name || message.actor;

    // Форматирование времени
    const timestamp = formatTimestamp(message.timestamp);

    return `[${timestamp}] ${actorName}: ${message.content}`;
  });

  return formattedMessages.join('\n\n');
}

/**
 * Экспортирует историю чата в буфер обмена
 * @param messages Список сообщений чата
 * @param sessionTitle Заголовок сессии чата
 * @returns Promise с результатом операции
 */
export async function exportChatHistory(messages: ChatMessage[], sessionTitle?: string): Promise<boolean> {
  try {
    const header = sessionTitle ? `=== История чата: ${sessionTitle} ===\n\n` : '=== История чата ===\n\n';
    const formattedHistory = header + formatChatHistory(messages);

    // Копируем в буфер обмена
    await navigator.clipboard.writeText(formattedHistory);
    return true;
  } catch (error) {
    console.error('Ошибка при экспорте истории чата:', error);
    return false;
  }
}

/**
 * Форматирует временную метку в читаемый формат даты и времени
 * @param timestamp Временная метка в миллисекундах
 * @returns Отформатированная строка даты и времени
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}
