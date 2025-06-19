// File: services/ai/GeminiService.test.js
const GeminiService = require('./GeminiService');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Removed HarmCategory, HarmBlockThreshold

// Мокируем SDK
jest.mock('@google/generative-ai');

describe('GeminiService', () => {
    const MOCK_API_KEY = 'test_gemini_api_key';
    let originalEnv;
    let mockGenerateContent;
    let mockSendMessage;
    let mockStartChat;
    let mockGetGenerativeModel;

    beforeEach(() => {
        originalEnv = { ...process.env };
        delete process.env.GEMINI_API_KEY;

        mockGenerateContent = jest.fn();
        mockSendMessage = jest.fn();
        mockStartChat = jest.fn(() => ({
            sendMessage: mockSendMessage
        }));
        mockGetGenerativeModel = jest.fn(() => ({
            generateContent: mockGenerateContent,
            startChat: mockStartChat
        }));

        GoogleGenerativeAI.mockImplementation(() => ({
            getGenerativeModel: mockGetGenerativeModel
        }));
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.clearAllMocks();
    });

    describe('Constructor and _ensureClient', () => {
        test('should initialize GoogleGenerativeAI client if API key is provided in constructor', () => {
            new GeminiService(MOCK_API_KEY);
            // _ensureClient is not called by constructor, client is lazy-loaded.
            // This test should verify that _ensureClient works when called.
            const service = new GeminiService(MOCK_API_KEY);
            service._ensureClient(); // Manually call to test initialization
            expect(GoogleGenerativeAI).toHaveBeenCalledTimes(1);
            expect(GoogleGenerativeAI).toHaveBeenCalledWith(MOCK_API_KEY);
        });

        test('should initialize GoogleGenerativeAI client if GEMINI_API_KEY env var is set', () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            service._ensureClient(); // Manually call
            expect(GoogleGenerativeAI).toHaveBeenCalledTimes(1);
            expect(GoogleGenerativeAI).toHaveBeenCalledWith(MOCK_API_KEY);
        });

        test('_ensureClient should return false and warn if key is missing', () => {
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const service = new GeminiService(null); // No key
            const clientReady = service._ensureClient(); // Attempt to ensure

            expect(clientReady).toBe(false);
            expect(GoogleGenerativeAI).not.toHaveBeenCalled();
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("API key for Gemini is missing. Cannot initialize client for actual calls."));
            consoleWarnSpy.mockRestore();
        });

        test('_ensureClient should throw if client initialization fails with a key', () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            GoogleGenerativeAI.mockImplementationOnce(() => { throw new Error("Init failed")});
            const service = new GeminiService(null);
            expect(() => service._ensureClient()).toThrow("GeminiService client initialization failed: Init failed");
        });
    });

    describe('generateText', () => {
        test('should return stubbed response if API key is missing', async () => {
            const service = new GeminiService(null); // No key
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const result = await service.generateText("plan something");
            expect(result).toContain("stub due to missing API key");
            expect(mockGetGenerativeModel).not.toHaveBeenCalled();
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("GEMINI_API_KEY is not set"));
            consoleWarnSpy.mockRestore();
        });

        test('should call Gemini API with correct parameters for generateText', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null, { defaultModel: 'gemini-default', temperature: 0.6, maxTokens: 100 });
            const prompt = "Test prompt";
            const params = { model: 'gemini-custom', temperature: 0.8, maxTokens: 150, stopSequences: ["stop"], systemInstruction: "Be helpful" };

            mockGenerateContent.mockResolvedValue({ response: { text: () => "Generated text" } });

            const result = await service.generateText(prompt, params);

            expect(mockGetGenerativeModel).toHaveBeenCalledWith({
                model: 'gemini-custom',
                generationConfig: {
                    temperature: 0.8,
                    maxOutputTokens: 150,
                    stopSequences: ["stop"]
                },
                safetySettings: expect.any(Array),
                systemInstruction: { role: "system", parts: [{text: "Be helpful"}] }
            });
            expect(mockGenerateContent).toHaveBeenCalledWith(prompt);
            expect(result).toBe("Generated text");
        });

        test('should use default parameters if not provided in call or baseConfig', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null); // uses defaultModel 'gemini-pro' from class
            mockGenerateContent.mockResolvedValue({ response: { text: () => "Default text" } });

            await service.generateText("A prompt");
            expect(mockGetGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({
                model: 'gemini-pro', // service default
                generationConfig: expect.objectContaining({
                    temperature: 0.7, // built-in default in service method
                    maxOutputTokens: 2048 // built-in default in service method
                })
            }));
        });

        test('should handle API error during generateText', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            mockGenerateContent.mockRejectedValue(new Error("API Failure"));

            await expect(service.generateText("prompt")).rejects.toThrow("Gemini API Error: API Failure");
        });

        test('should handle malformed API response (no text function) in generateText', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            mockGenerateContent.mockResolvedValue({ response: { /* no text function */ candidates: [{content: {parts: [{text: "candidate text"}] }}] } });
            const result = await service.generateText("prompt");
            expect(result).toBe("candidate text"); // Check fallback
        });

        test('should throw if API response has no text function and no valid candidates', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            mockGenerateContent.mockResolvedValue({ response: { /* no text function and no candidates */ } });
            await expect(service.generateText("prompt")).rejects.toThrow("Gemini API response format error: No text content found.");
        });

        test('should throw if client is not available after _ensureClient (e.g. key removed post-construction)', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            // Simulate client failing to initialize or becoming unavailable
            service.genAI = null; // Ensure it's null
            service._ensureClient = jest.fn(() => { service.genAI = null; return false; }); // Mock _ensureClient to fail setting genAI

            await expect(service.generateText("prompt")).rejects.toThrow("GeminiService: GoogleGenerativeAI client is not available.");
        });
    });

    describe('completeChat', () => {
        test('should return stubbed response if API key is missing', async () => {
            const service = new GeminiService(null);
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const result = await service.completeChat([{role: 'user', content: 'Hi'}]);
            expect(result).toContain("stub due to missing API key");
            expect(mockGetGenerativeModel).not.toHaveBeenCalled();
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("GEMINI_API_KEY is not set"));
            consoleWarnSpy.mockRestore();
        });

        test('should call Gemini API with correct parameters for completeChat', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null, { defaultModel: 'gemini-chat-default' });
            const messages = [
                { role: 'system', content: 'System instruction from messages.' }, // Will be extracted
                { role: 'user', content: 'Hello Gemini' },
                { role: 'assistant', content: 'Hello User' }, // Will be 'model'
                { role: 'user', content: 'How are you?' } // This will be sent via sendMessage
            ];
            const params = { model: 'gemini-chat-custom', temperature: 0.9, maxTokens: 500 };

            mockSendMessage.mockResolvedValue({ response: { text: () => "I am fine, thanks!" } });

            const result = await service.completeChat(messages, params);

            expect(mockGetGenerativeModel).toHaveBeenCalledWith({
                model: 'gemini-chat-custom',
                generationConfig: {
                    temperature: 0.9,
                    maxOutputTokens: 500,
                },
                safetySettings: expect.any(Array),
                systemInstruction: { role: "system", parts: [{text: "System instruction from messages."}] }
            });
            expect(mockStartChat).toHaveBeenCalledWith({
                history: [
                    { role: 'user', parts: [{ text: 'Hello Gemini' }] },
                    { role: 'model', parts: [{ text: 'Hello User' }] }
                ]
            });
            expect(mockSendMessage).toHaveBeenCalledWith('How are you?');
            expect(result).toBe("I am fine, thanks!");
        });

        test('should use params.systemInstruction if provided, ignoring system message in messages array', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            const messages = [
                { role: 'system', content: 'This should be ignored.' },
                { role: 'user', content: 'User message' }
            ];
            const params = { systemInstruction: "Use this system instruction." };
            mockSendMessage.mockResolvedValue({ response: { text: () => "Response" } });

            await service.completeChat(messages, params);
            expect(mockGetGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({
                 systemInstruction: { role: "system", parts: [{text: "Use this system instruction."}] }
            }));
            expect(mockStartChat).toHaveBeenCalledWith(expect.objectContaining({
                history: []
            }));
            expect(mockSendMessage).toHaveBeenCalledWith('User message');
        });


        test('should handle API error during completeChat (sendMessage)', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            mockSendMessage.mockRejectedValue(new Error("Chat API Failure"));

            await expect(service.completeChat([{role: 'user', content: 'Hi'}])).rejects.toThrow("Gemini API Chat Error: Chat API Failure");
        });

        test('should handle empty user message if history is also empty but system instruction exists', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            const messages = [{role: 'system', content: 'Be brief'}];
            mockSendMessage.mockResolvedValue({ response: { text: () => "Okay." } });

            await service.completeChat(messages, {});
            expect(mockGetGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({
                systemInstruction: {role: "system", parts: [{text: "Be brief"}]}
            }));
            expect(mockStartChat).toHaveBeenCalledWith({ history: [] });
            expect(mockSendMessage).toHaveBeenCalledWith("");
        });

        test('should throw if client is not available after _ensureClient for completeChat', async () => {
            process.env.GEMINI_API_KEY = MOCK_API_KEY;
            const service = new GeminiService(null);
            service.genAI = null;
            service._ensureClient = jest.fn(() => { service.genAI = null; return false; });

            await expect(service.completeChat([{role: 'user', content: 'Hi'}])).rejects.toThrow("GeminiService: GoogleGenerativeAI client is not available.");
        });
    });
});
