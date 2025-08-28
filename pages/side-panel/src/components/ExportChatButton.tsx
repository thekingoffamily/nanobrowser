import React from 'react';
import { FaFileExport } from 'react-icons/fa';
import { exportChatHistory } from '../utils/chatExport';
import { ChatMessage } from '@extension/storage';
import { t } from '@extension/i18n';

interface ExportButtonProps {
  messages: ChatMessage[];
  sessionTitle?: string;
  isDarkMode?: boolean;
  onClick?: () => void;
}

const ExportChatButton: React.FC<ExportButtonProps> = ({ messages, sessionTitle, isDarkMode = false, onClick }) => {
  const handleExport = async () => {
    if (messages.length === 0) {
      return;
    }

    const success = await exportChatHistory(messages, sessionTitle);

    if (success) {
      // Можно добавить всплывающее уведомление
      console.log('История чата успешно скопирована в буфер обмена');
    }

    // Вызов дополнительного обработчика если нужно
    if (onClick) {
      onClick();
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={messages.length === 0}
      className={`rounded p-2 transition-colors ${
        isDarkMode
          ? 'bg-slate-800 text-sky-400 hover:bg-slate-700 disabled:bg-slate-900 disabled:text-slate-600'
          : 'bg-white text-sky-500 hover:bg-gray-100 disabled:bg-gray-100 disabled:text-gray-400'
      }`}
      title={t('export_chat_history') || 'Экспортировать историю чата'}
      aria-label={t('export_chat_history') || 'Экспортировать историю чата'}
      type="button">
      <FaFileExport size={20} />
    </button>
  );
};

export default ExportChatButton;
