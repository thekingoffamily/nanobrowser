# 🔍 Руководство по отладке Nanobrowser

## 📊 Основные исправления в этой версии

### 🔧 Улучшения для G4F API:
- **Улучшенная обработка JSON**: G4F модели теперь используют ручное извлечение JSON
- **Fallback механизм**: При ошибках structured output автоматически переключается на ручной режим
- **Умное извлечение**: Поиск JSON в текстовом ответе и создание структуры из обычного текста
- **Подробное логирование**: Новые логи для отслеживания процесса извлечения JSON
- **🆕 Адаптивные промпты**: Специальные инструкции JSON для G4F моделей в промптах
- **🆕 Усиленные JSON правила**: Четкие правила формата ответа для ненадежных моделей

### 🔍 Новые логи для отслеживания:
- **🔧 [API-CONFIG]** - Конфигурация API провайдеров
- **🔍 [JSON-EXTRACT]** - Процесс извлечения JSON
- **🤖 [JSON-EXTRACT]** - Создание структуры из текста
- **🆘 [JSON-EXTRACT]** - Последняя попытка создания структуры
- **⚠️ [API-IN]** - Предупреждения о fallback'ах
- **🔧 [PLANNER-PROMPT]** - Конфигурация промптов Planner для G4F
- **🔧 [NAVIGATOR-PROMPT]** - Конфигурация промптов Navigator для G4F

## 📋 Что добавлено

Во все ключевые компоненты приложения добавлено подробное логирование с эмодзи для легкого поиска в консоли:

### 🎯 Основные префиксы логов:

- **🔥 [NANOBROWSER]** - Основные операции background script
- **🔨 [EXECUTOR]** - Операции исполнителя задач
- **📊 [PLANNER]** - Работа планировщика
- **🦭 [NAVIGATOR]** - Работа навигатора
- **🤖 [G4F]** - G4F API интеграция
- **🌐 [UI-G4F]** - G4F в пользовательском интерфейсе

## 🛠️ Как использовать логи

### 1. Откройте Developer Tools
- Установите расширение в Chrome
- Перейдите в `chrome://extensions/`
- Найдите Nanobrowser и нажмите "Inspect views: background page"
- Откроется консоль background script

### 2. Фильтрация логов
Используйте эти фильтры в консоли для поиска конкретных операций:

```
🔥 [NANOBROWSER]     # Общие операции
🔨 [EXECUTOR]        # Выполнение задач
📊 [PLANNER]         # Планирование
🦭 [NAVIGATOR]       # Навигация
🤖 [G4F]             # G4F API
```

### 3. Типичные сценарии отладки

#### ❓ Задача не запускается
Ищите в логах:
```
🔥 [NANOBROWSER] Received message from side panel: new_task
🔨 [EXECUTOR] Creating new executor instance
🔨 [EXECUTOR] Setting up executor for task
```

#### ❓ Проблемы с G4F
Ищите в логах:
```
🤖 [G4F] Checking G4F API status
🤖 [G4F] Starting model fetch
🌐 [UI-G4F] Starting model fetch for provider
🔧 [API-CONFIG] G4F провайдер - используется ручное извлечение JSON
🔍 [JSON-EXTRACT] Ищем JSON в тексте для G4F модели...
⚠️ [API-IN] Structured output не сработал для G4F, пробуем ручное извлечение...
```

#### ❓ JSON парсинг не работает
Ищите в логах:
```
🔍 [JSON-EXTRACT] Извлечение JSON из ответа...
✅ [JSON-EXTRACT] Найден валидный JSON в тексте
❌ [JSON-EXTRACT] Невалидный JSON найден
🤖 [JSON-EXTRACT] JSON не найден, создаем структуру из текста...
🆘 [JSON-EXTRACT] Последняя попытка - создаем минимальную структуру...
```

#### ❓ Агенты не работают
Ищите в логах:
```
📊 [PLANNER] Starting planner execution
🦭 [NAVIGATOR] Starting navigator execution
🔨 [EXECUTOR] Running planner
🔨 [EXECUTOR] Running navigator
```

#### ❓ Ошибки выполнения
Ищите в логах:
```
❌ [EXECUTOR] Task execution failed
❌ [PLANNER] Execution failed
❌ [NAVIGATOR] Navigation execution failed
❌ [G4F] Status check failed
```

## 🎯 Ключевые моменты для мониторинга

### ✅ Успешный запуск выглядит так:
```
🔥 [NANOBROWSER] Extension background script starting...
🔥 [NANOBROWSER] Side panel port established successfully
🔥 [NANOBROWSER] Starting NEW TASK: ваша задача
🔨 [EXECUTOR] Creating new executor instance...
📊 [PLANNER] Starting planner execution...
🦭 [NAVIGATOR] Starting navigator execution...
```

### ⚠️ Проблемы G4F выглядят так:
```
❌ [G4F] Status check failed: Failed to fetch
❌ [G4F] All attempts failed, using default models
🤖 [G4F] API returned error status: 500 Internal Server Error
```

### 🚨 Критические ошибки выглядят так:
```
❌ [NANOBROWSER] Task execution failed: No API keys configured
❌ [EXECUTOR] Task failed with error: Navigator model not configured
❌ [PLANNER] Authentication error detected
```

## 📱 Логи в UI (Options страница)

Для G4F интеграции в настройках также добавлены логи:
```
🌐 [UI-G4F] Starting model fetch for provider: g4f
✅ [UI-G4F] Successfully fetched 8 models
❌ [UI-G4F] Failed to fetch models after retries
```

## 🔧 Полезные команды в консоли

```javascript
// Посмотреть все логи с определенным префиксом
console.history?.filter(log => log.includes('[G4F]'))

// Очистить консоль
console.clear()

// Включить подробные логи
localStorage.setItem('debug', 'true')
```

## 📝 Что дальше?

1. **Установите новое расширение** из `dist-zip/extension-20250823-183308.zip`
2. **Откройте консоль** background script
3. **Запустите задачу** и наблюдайте за логами
4. **Используйте фильтры** для поиска конкретных проблем
5. **Делитесь логами** при сообщении о проблемах

### 🎆 Особенности новой версии:
- **Лучшая поддержка G4F**: Теперь G4F модели работают стабильнее благодаря улучшенному парсингу
- **Автоматический fallback**: При ошибках система автоматически переключается на альтернативные методы
- **Подробное логирование**: Вы можете видеть каждый шаг обработки ответов от AI

## 🆘 Если проблемы остаются

Скопируйте релевантные логи из консоли и опишите:
- Что вы пытались сделать
- Что ожидали увидеть
- Что произошло на самом деле
- Какие логи показывает консоль

Теперь вы сможете точно видеть, что происходит на каждом этапе работы приложения! 🎉