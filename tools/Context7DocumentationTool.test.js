// File: tools/Context7DocumentationTool.test.js
const Context7DocumentationTool = require('./Context7DocumentationTool');
const Context7Client = require('../services/Context7Client'); // Path to the actual client

// Mock the Context7Client
jest.mock('../services/Context7Client');

describe('Context7DocumentationTool', () => {
    let mockClientInstance;
    let tool;

    beforeEach(() => {
        // Reset the mock before each test
        Context7Client.mockClear();

        // Create a mock instance of Context7Client
        // We will mock its methods (resolveLibraryId, getLibraryDocs) per test case
        mockClientInstance = {
            resolveLibraryId: jest.fn(),
            getLibraryDocs: jest.fn()
        };
        // Configure the mock constructor to return our mock instance
        Context7Client.mockImplementation(() => mockClientInstance);

        // Now, create the tool with the mocked client constructor behavior
        // The Context7DocumentationTool constructor expects an instance.
        // Since Context7Client is mocked, `new Context7Client()` will return what the mockImplementation is set to.
        // For clarity, we can just pass the mockClientInstance directly if constructor allows.
        // The provided tool code is `tool = new Context7DocumentationTool(new Context7Client());`
        // which means `new Context7Client()` inside the tool's test setup will indeed use the mock.
        tool = new Context7DocumentationTool(new Context7Client());
        // This also means tool.client will be the object returned by the mock Context7Client constructor,
        // which we've set to be mockClientInstance.
    });

    describe('Constructor', () => {
        test('should throw error if an invalid client instance is provided', () => {
            // Redefine mock for this specific test case to return something else or null
            Context7Client.mockImplementationOnce(() => null);
            expect(() => new Context7DocumentationTool(new Context7Client())).toThrow('Context7DocumentationTool: Invalid Context7Client instance provided.');

            const invalidClient = {}; // Missing methods
            Context7Client.mockImplementationOnce(() => invalidClient);
            expect(() => new Context7DocumentationTool(new Context7Client())).toThrow('Context7DocumentationTool: Invalid Context7Client instance provided.');
        });

        test('should successfully initialize with a valid mock client instance', () => {
            // mockClientInstance is already set up in beforeEach to be returned by new Context7Client()
            expect(tool.client).toBe(mockClientInstance);
        });
    });

    describe('execute', () => {
        const validInput = { libraryName: 'React', topic: 'hooks', maxTokens: 3000 };

        test('should successfully fetch documentation', async () => {
            mockClientInstance.resolveLibraryId.mockResolvedValueOnce('react-id');
            mockClientInstance.getLibraryDocs.mockResolvedValueOnce('React Hooks documentation content.');

            const result = await tool.execute(validInput);

            expect(mockClientInstance.resolveLibraryId).toHaveBeenCalledWith('React');
            expect(mockClientInstance.getLibraryDocs).toHaveBeenCalledWith('react-id', 'hooks', 3000);
            expect(result).toEqual({ result: 'React Hooks documentation content.', error: null });
        });

        test('should use default maxTokens if not provided', async () => {
            const inputWithoutTokens = { libraryName: 'Vue', topic: 'computed' };
            mockClientInstance.resolveLibraryId.mockResolvedValueOnce('vue-id');
            mockClientInstance.getLibraryDocs.mockResolvedValueOnce('Vue computed docs.');

            await tool.execute(inputWithoutTokens);

            expect(mockClientInstance.getLibraryDocs).toHaveBeenCalledWith('vue-id', 'computed', 5000); // 5000 is default in tool
        });

        test('should handle topic being null or undefined', async () => {
            const inputWithoutTopic = { libraryName: 'Angular' };
             mockClientInstance.resolveLibraryId.mockResolvedValueOnce('angular-id');
            mockClientInstance.getLibraryDocs.mockResolvedValueOnce('Angular general docs.');

            await tool.execute(inputWithoutTopic);

            expect(mockClientInstance.getLibraryDocs).toHaveBeenCalledWith('angular-id', null, 5000);
        });

        test('should return error if libraryName is invalid', async () => {
            const result1 = await tool.execute({ libraryName: '' });
            expect(result1).toEqual({ result: null, error: "Invalid input: 'libraryName' must be a non-empty string." });

            const result2 = await tool.execute({ libraryName: null });
            expect(result2).toEqual({ result: null, error: "Invalid input: 'libraryName' must be a non-empty string." });
        });

        test('should return error if resolveLibraryId fails or returns empty', async () => {
            mockClientInstance.resolveLibraryId.mockResolvedValueOnce(''); // Empty ID
            let result = await tool.execute(validInput);
            expect(result).toEqual({ result: null, error: 'Could not resolve library ID for "React". The library might not be supported by Context7.' });

            mockClientInstance.resolveLibraryId.mockClear(); // Clear previous mock setup for this specific method call
            mockClientInstance.resolveLibraryId.mockResolvedValueOnce(null); // Null ID
            result = await tool.execute(validInput);
            expect(result).toEqual({ result: null, error: 'Could not resolve library ID for "React". The library might not be supported by Context7.' });
        });

        test('should return specific message if getLibraryDocs returns empty documentation', async () => {
            mockClientInstance.resolveLibraryId.mockResolvedValueOnce('react-id');
            mockClientInstance.getLibraryDocs.mockResolvedValueOnce(''); // Empty docs

            const result = await tool.execute(validInput);
            expect(result).toEqual({ result: 'No specific documentation found for library ID "react-id" (topic: hooks).', error: null });
        });

        test('should propagate error from resolveLibraryId if it starts with Context7Client or Context7 RPC Error', async () => {
            const clientError = new Error('Context7Client: Network Error during resolve');
            mockClientInstance.resolveLibraryId.mockRejectedValueOnce(clientError);

            const result = await tool.execute(validInput);
            expect(result).toEqual({ result: null, error: clientError.message });
        });

        test('should propagate error from getLibraryDocs if it starts with Context7Client or Context7 RPC Error', async () => {
            mockClientInstance.resolveLibraryId.mockResolvedValueOnce('react-id');
            const clientError = new Error('Context7 RPC Error (Tool: get-library-docs): API limit exceeded');
            mockClientInstance.getLibraryDocs.mockRejectedValueOnce(clientError);

            const result = await tool.execute(validInput);
            expect(result).toEqual({ result: null, error: clientError.message });
        });

        test('should return generic error for other exceptions not matching client error prefixes', async () => {
            const unknownError = new Error('Some other weird error');
            mockClientInstance.resolveLibraryId.mockRejectedValueOnce(unknownError);

            const result = await tool.execute(validInput);
            expect(result).toEqual({ result: null, error: `Failed to fetch documentation for "React": ${unknownError.message}` });
        });
    });
});
