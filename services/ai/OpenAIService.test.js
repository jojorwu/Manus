// File: services/ai/OpenAIService.test.js
const OpenAIService = require('./OpenAIService');
const OpenAI = require('openai'); // This will be the mocked version

// Mock the OpenAI library
jest.mock('openai');

describe('OpenAIService', () => {
    const mockApiKey = 'test-api-key';
    let originalEnv;

    beforeEach(() => {
        // Clear all instances and calls to constructor and methods.
        OpenAI.mockClear();
        if (OpenAI.prototype.chat && OpenAI.prototype.chat.completions) {
            OpenAI.prototype.chat.completions.create.mockClear();
        }
        // Store original environment variables
        originalEnv = { ...process.env };
    });

    afterEach(() => {
        // Restore original environment variables
        process.env = originalEnv;
    });

    describe('Constructor and Initialization', () => {
        test('should initialize with API key from constructor', () => {
            new OpenAIService(mockApiKey);
            expect(OpenAI).toHaveBeenCalledTimes(1);
            expect(OpenAI).toHaveBeenCalledWith({ apiKey: mockApiKey });
        });

        test('should initialize with API key from environment variable if not provided in constructor', () => {
            process.env.OPENAI_API_KEY = 'env-api-key';
            new OpenAIService(null);
            expect(OpenAI).toHaveBeenCalledTimes(1);
            expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'env-api-key' });
        });

        test('should warn if API key is not provided in constructor or environment', () => {
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            delete process.env.OPENAI_API_KEY; // Ensure it's not set
            new OpenAIService(null);
            expect(OpenAI).not.toHaveBeenCalled(); // Client not initialized
            expect(consoleWarnSpy).toHaveBeenCalledWith("OpenAIService: API key is not provided at construction and OPENAI_API_KEY env var is not set. Service will likely fail on execution.");
            consoleWarnSpy.mockRestore();
        });

        test('should handle OpenAI client initialization failure during construction', () => {
            OpenAI.mockImplementationOnce(() => {
                throw new Error('Init failed');
            });
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            new OpenAIService(mockApiKey);
            expect(consoleErrorSpy).toHaveBeenCalledWith("OpenAIService: Failed to initialize OpenAI client during construction. Error: Init failed");
            consoleErrorSpy.mockRestore();
        });

        test('should set defaultModel from baseConfig or use fallback', () => {
            const serviceWithConfig = new OpenAIService(mockApiKey, { defaultModel: 'gpt-4-test' });
            expect(serviceWithConfig.defaultModel).toBe('gpt-4-test');
            const serviceWithoutConfig = new OpenAIService(mockApiKey);
            expect(serviceWithoutConfig.defaultModel).toBe('gpt-3.5-turbo');
        });
    });

    describe('_getApiKey', () => {
        test('should return API key from constructor if available', () => {
            const service = new OpenAIService(mockApiKey);
            expect(service._getApiKey()).toBe(mockApiKey);
        });

        test('should return API key from environment if constructor key is not available', () => {
            process.env.OPENAI_API_KEY = 'env-key-for-get';
            const service = new OpenAIService(null);
            expect(service._getApiKey()).toBe('env-key-for-get');
        });

        test('should throw error if no API key is available', () => {
            delete process.env.OPENAI_API_KEY;
            const service = new OpenAIService(null);
            // Suppress console.warn during this specific test for cleaner output if constructor logs it
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expect(() => service._getApiKey()).toThrow("OpenAI API key is missing.");
            consoleWarnSpy.mockRestore();
        });
    });

    describe('_ensureClient', () => {
        test('should return true if client is already initialized', () => {
            const service = new OpenAIService(mockApiKey); // Initializes client
            expect(service._ensureClient()).toBe(true);
        });

        test('should attempt late initialization if client is null and API key becomes available', () => {
            delete process.env.OPENAI_API_KEY;
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); // Suppress constructor warning
            const service = new OpenAIService(null); // Client not initialized
            consoleWarnSpy.mockRestore();

            process.env.OPENAI_API_KEY = 'late-env-key';
            const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            OpenAI.mockClear(); // Clear previous constructor calls if any (shouldn't be)

            expect(service._ensureClient()).toBe(true);
            expect(OpenAI).toHaveBeenCalledTimes(1);
            expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'late-env-key' });
            expect(consoleLogSpy).toHaveBeenCalledWith("OpenAIService: Attempting late initialization of OpenAI client.");
            consoleLogSpy.mockRestore();
        });

        test('should throw error if client cannot be initialized due to missing key (late attempt)', () => {
            delete process.env.OPENAI_API_KEY;
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const service = new OpenAIService(null); // Client not initialized
            consoleWarnSpy.mockRestore();

            expect(() => service._ensureClient()).toThrow("OpenAIService: OpenAI client is not initialized. API key might be missing or initialization failed.");
        });

        test('should handle late initialization failure', () => {
            delete process.env.OPENAI_API_KEY;
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const service = new OpenAIService(null); // Client not initialized
            consoleWarnSpy.mockRestore();

            process.env.OPENAI_API_KEY = 'late-env-key-fail';
            OpenAI.mockImplementationOnce(() => { throw new Error('Late init failed'); });
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            expect(() => service._ensureClient()).toThrow("OpenAIService: OpenAI client is not initialized. API key might be missing or initialization failed.");
            expect(consoleErrorSpy).toHaveBeenCalledWith("OpenAIService: Failed to initialize OpenAI client (late attempt). Error: Late init failed");
            consoleErrorSpy.mockRestore();
        });
    });


    describe('completeChat', () => {
        const messages = [{ role: 'user', content: 'Hello' }];

        test('should call OpenAI chat completions API with correct parameters', async () => {
            const service = new OpenAIService(mockApiKey);
            const mockResponse = { choices: [{ message: { content: 'Hi there!' }, finish_reason: 'stop' }], model: 'gpt-3.5-turbo-test' };
            OpenAI.prototype.chat.completions.create.mockResolvedValue(mockResponse);

            const result = await service.completeChat(messages, { model: 'gpt-4-custom', temperature: 0.5, maxTokens: 100, topP: 0.9, stopSequences: ['\n'] });

            expect(OpenAI.prototype.chat.completions.create).toHaveBeenCalledWith({
                model: 'gpt-4-custom',
                messages: messages,
                temperature: 0.5,
                max_tokens: 100,
                top_p: 0.9,
                stop: ['\n']
            });
            expect(result).toBe('Hi there!');
        });

        test('should use default parameters if not provided', async () => {
            const service = new OpenAIService(mockApiKey, { temperature: 0.8, maxTokens: 500 });
            const mockResponse = { choices: [{ message: { content: 'Default response' }, finish_reason: 'stop' }], model: 'gpt-3.5-turbo' };
            OpenAI.prototype.chat.completions.create.mockResolvedValue(mockResponse);

            await service.completeChat(messages);
            expect(OpenAI.prototype.chat.completions.create).toHaveBeenCalledWith({
                model: 'gpt-3.5-turbo', // Service default model
                messages: messages,
                temperature: 0.8,    // From baseConfig
                max_tokens: 500      // From baseConfig
            });
        });

        test('should use service default model if params.model is not provided', async () => {
            const service = new OpenAIService(mockApiKey, { defaultModel: 'service-default-model' });
            const mockResponse = { choices: [{ message: { content: 'Response' } }] };
            OpenAI.prototype.chat.completions.create.mockResolvedValue(mockResponse);

            await service.completeChat(messages, { temperature: 0.5 });
            expect(OpenAI.prototype.chat.completions.create).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'service-default-model' })
            );
        });


        test('should throw error if messages array is empty', async () => {
            const service = new OpenAIService(mockApiKey);
            await expect(service.completeChat([])).rejects.toThrow("Messages array cannot be empty and must be an array.");
        });

        test('should throw error if messages have invalid structure', async () => {
            const service = new OpenAIService(mockApiKey);
            const invalidMessages = [{ role: 'user' }, { content: 'missing role' }];
            // @ts-ignore // Suppress TypeScript error for intentionally invalid input
            await expect(service.completeChat(invalidMessages)).rejects.toThrow("Each message in the array must have a 'role' (string) and 'content' (string).");
        });

        test('should throw error if API key is missing (via _ensureClient)', async () => {
            delete process.env.OPENAI_API_KEY;
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const service = new OpenAIService(null); // Client not initialized
            consoleWarnSpy.mockRestore();
            await expect(service.completeChat(messages)).rejects.toThrow("OpenAIService: OpenAI client is not initialized. API key might be missing or initialization failed.");
        });

        test('should handle OpenAI API error (e.g. rate limit, server error)', async () => {
            const service = new OpenAIService(mockApiKey);
            const apiError = new Error("API Error Message");
            // @ts-ignore // Simulate OpenAI error structure
            apiError.response = { data: { error: { message: "Detailed API error from response." } } };
            OpenAI.prototype.chat.completions.create.mockRejectedValue(apiError);
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            await expect(service.completeChat(messages)).rejects.toThrow("OpenAI API Error: Detailed API error from response.");
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("OpenAIService: Error during OpenAI API call to model gpt-3.5-turbo: Detailed API error from response."),
                expect.any(String) // for error.stack
            );
            consoleErrorSpy.mockRestore();
        });

        test('should handle OpenAI API error with alternative error structure', async () => {
            const service = new OpenAIService(mockApiKey);
            const apiError = new Error("Fallback error message");
             // @ts-ignore
            apiError.error = { message: "Detailed API error from error.error.message" };
            OpenAI.prototype.chat.completions.create.mockRejectedValue(apiError);
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            await expect(service.completeChat(messages)).rejects.toThrow("OpenAI API Error: Detailed API error from error.error.message");
            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });


        test('should throw error if API response has no choices', async () => {
            const service = new OpenAIService(mockApiKey);
            OpenAI.prototype.chat.completions.create.mockResolvedValue({ choices: [] });
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            await expect(service.completeChat(messages)).rejects.toThrow("OpenAI API response format error: No choices returned.");
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                "OpenAIService API response format warning: No choices returned.",
                { choices: [] }
            );
            consoleWarnSpy.mockRestore();
        });

        test('should throw error if choice has no message content', async () => {
            const service = new OpenAIService(mockApiKey);
            OpenAI.prototype.chat.completions.create.mockResolvedValue({ choices: [{ message: {} }] });
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            await expect(service.completeChat(messages)).rejects.toThrow("OpenAI API response format error: No message content found in the first choice.");
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                "OpenAIService API response format warning: No message content found in the first choice.",
                { message: {} }
            );
            consoleWarnSpy.mockRestore();
        });
    });

    describe('generateText', () => {
        test('should call completeChat with correct message structure', async () => {
            const service = new OpenAIService(mockApiKey);
            const completeChatSpy = jest.spyOn(service, 'completeChat').mockResolvedValue('Generated text');

            const prompt = "Generate some text.";
            const params = { model: 'text-davinci-003', temperature: 0.6 };
            await service.generateText(prompt, params);

            expect(completeChatSpy).toHaveBeenCalledWith(
                [{ role: 'user', content: prompt }],
                params
            );
            completeChatSpy.mockRestore();
        });

        test('should include system message if provided', async () => {
            const service = new OpenAIService(mockApiKey);
            const completeChatSpy = jest.spyOn(service, 'completeChat').mockResolvedValue('Generated text with system message');

            const prompt = "User prompt.";
            const systemMessage = "System instruction.";
            const params = { systemMessage: systemMessage, temperature: 0.5 };
            // chatParams will not have systemMessage
            const expectedChatParams = { temperature: 0.5 };


            await service.generateText(prompt, params);

            expect(completeChatSpy).toHaveBeenCalledWith(
                [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: prompt }
                ],
                expectedChatParams
            );
            completeChatSpy.mockRestore();
        });

        test('should throw error if prompt is not a string', async () => {
            const service = new OpenAIService(mockApiKey);
            // @ts-ignore // Suppress TypeScript error for intentionally invalid input
            await expect(service.generateText(123)).rejects.toThrow("Prompt must be a string for generateText.");
        });
    });
});
