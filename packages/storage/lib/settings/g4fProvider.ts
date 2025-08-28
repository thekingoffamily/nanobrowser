export interface G4FModel {
  id: string;
  object: string;
  created: number;
  owned_by: string | null;
}

export interface G4FStatus {
  isAvailable: boolean;
  message: string;
  modelsCount?: number;
}

export async function checkG4FStatus(baseUrl: string): Promise<G4FStatus> {
  console.log('🔍 [G4F] Checking G4F API status at:', baseUrl);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('⏰ [G4F] Status check timeout after 3 seconds');
      controller.abort();
    }, 3000); // 3 second timeout

    console.log('📡 [G4F] Sending status check request...');
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    clearTimeout(timeoutId);
    console.log('📊 [G4F] Status check response:', response.status, response.statusText);

    if (response.ok) {
      const data = await response.json();
      const modelsCount = Array.isArray(data) ? data.length : 0;
      console.log('✅ [G4F] API is running with', modelsCount, 'models available');
      return {
        isAvailable: true,
        message: `G4F API is running (${modelsCount} models available)`,
        modelsCount,
      };
    } else {
      console.error('❌ [G4F] API returned error status:', response.status, response.statusText);
      return {
        isAvailable: false,
        message: `G4F API returned ${response.status}: ${response.statusText}`,
      };
    }
  } catch (error: unknown) {
    console.error('❌ [G4F] Status check failed:', error);
    return {
      isAvailable: false,
      message: `G4F API is not available: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

export async function fetchG4FModels(baseUrl: string, retries: number = 3): Promise<string[]> {
  const defaultModels = [
    'qwen-2.5',
    'qwen-3-32b',
    'qwen-3-14b',
    'qwen-3-4b',
    'qwq-32b',
    'phi-4',
    'gemma-2-9b',
    'gemma-3-4b',
  ];

  console.log('🤖 [G4F] Starting model fetch from:', baseUrl);
  console.log('🤖 [G4F] Default models available:', defaultModels.length);
  console.log('🤖 [G4F] Max retries:', retries);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🔄 [G4F] Attempt ${attempt}/${retries} to fetch models from ${baseUrl}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log('⏰ [G4F] Request timeout after 5 seconds');
        controller.abort();
      }, 5000); // 5 second timeout

      console.log('📡 [G4F] Sending models request...');
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      });

      clearTimeout(timeoutId);
      console.log('📊 [G4F] Response received:', response.status, response.statusText);

      if (!response.ok) {
        console.error('❌ [G4F] HTTP error:', response.status, response.statusText);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      console.log('📦 [G4F] Parsing response data...');
      const data = await response.json();

      if (Array.isArray(data) && data.length > 0) {
        const models = data.map((model: G4FModel) => model.id);
        console.log('✅ [G4F] Successfully fetched', models.length, 'models');
        console.log(
          '📋 [G4F] Available models:',
          models.slice(0, 10),
          models.length > 10 ? `... and ${models.length - 10} more` : '',
        );

        // Filter to only working models without authentication
        const workingModels = models.filter(model => defaultModels.includes(model));
        console.log('✅ [G4F] Found', workingModels.length, 'working models:', workingModels);

        return workingModels.length > 0 ? workingModels : models;
      }

      // If we get empty array, try again (unless it's the last attempt)
      if (attempt < retries) {
        console.warn(`⚠️ [G4F] Empty models list on attempt ${attempt}, retrying in ${attempt} seconds...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Progressive delay
        continue;
      }

      console.warn('⚠️ [G4F] API returned empty models list, using defaults');
      return defaultModels;
    } catch (error: unknown) {
      console.error(
        `❌ [G4F] Attempt ${attempt}/${retries} failed:`,
        error instanceof Error ? error.message : 'Unknown error',
      );

      // If this is the last attempt, return defaults
      if (attempt === retries) {
        console.warn('❌ [G4F] All attempts failed, using default models:', defaultModels);
        return defaultModels;
      }

      // Progressive delay between retries
      const delay = 1000 * attempt;
      console.log(`⏰ [G4F] Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Fallback (should never reach here)
  console.warn('⚠️ [G4F] Unexpected fallback, using default models');
  return defaultModels;
}
