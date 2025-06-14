// File: services/Context7Client.test.js
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const Context7Client = require('./Context7Client');

jest.mock('axios'); // Mock axios
jest.mock('uuid'); // Mock uuid for predictable request IDs

describe('Context7Client', () => {
    const SERVER_URL = 'http://localhost:8080/mcp';
    let client;
    let mockPost;

    beforeEach(() => {
        mockPost = jest.fn();
        axios.create.mockReturnValue({ post: mockPost }); // mock axios instance creation
        uuidv4.mockReturnValue('test-uuid-123'); // Predictable UUID
        client = new Context7Client(SERVER_URL);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Constructor', () => {
        test('should initialize with default URL if none provided', () => {
            const defaultClient = new Context7Client();
            expect(defaultClient.serverUrl).toBe('http://localhost:8080/mcp');
        });
        test('should initialize httpClient with correct headers', () => {
            expect(axios.create).toHaveBeenCalledWith({
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream'
                }
            });
        });
    });

    describe('_sendRpcRequest', () => {
        test('should send correct JSON-RPC payload and return tool result on success', async () => {
            const mockToolResult = { data: "some data" };
            mockPost.mockResolvedValue({
                data: {
                    jsonrpc: '2.0',
                    id: 'test-uuid-123',
                    result: {
                        tool: {
                            name: 'test-tool',
                            result: mockToolResult
                        }
                    }
                },
                status: 200
            });

            const result = await client._sendRpcRequest('tools/call', 'test-tool', { arg1: 'val1' });

            expect(mockPost).toHaveBeenCalledWith(SERVER_URL, {
                jsonrpc: '2.0',
                id: 'test-uuid-123',
                method: 'tools/call',
                params: {
                    tool: {
                        name: 'test-tool',
                        args: { arg1: 'val1' }
                    }
                }
            });
            expect(result).toEqual(mockToolResult);
        });

        test('should throw error if JSON-RPC response ID mismatch', async () => {
            mockPost.mockResolvedValue({
                data: { jsonrpc: '2.0', id: 'wrong-id', result: {} },
                status: 200
            });
            await expect(client._sendRpcRequest('tools/call', 'test-tool', {}))
                .rejects.toThrow('Invalid JSON-RPC response: ID mismatch or version incorrect.');
        });

        test('should throw formatted error if RPC error field is present', async () => {
            mockPost.mockResolvedValue({
                data: {
                    jsonrpc: '2.0',
                    id: 'test-uuid-123',
                    error: { code: -32000, message: 'Server error' }
                },
                status: 200
            });
            await expect(client._sendRpcRequest('tools/call', 'test-tool', {}))
                .rejects.toThrow('Context7 RPC Error (Tool: test-tool): Server error (Code: -32000)');
        });

        test('should throw error if tool name in response mismatches', async () => {
            mockPost.mockResolvedValue({
                data: {
                    jsonrpc: '2.0',
                    id: 'test-uuid-123',
                    result: { tool: { name: 'another-tool', result: {} } }
                },
                status: 200
            });
            await expect(client._sendRpcRequest('tools/call', 'test-tool', {}))
                .rejects.toThrow('Context7 RPC Response: Tool name mismatch. Expected test-tool, got another-tool.');
        });

        test('should throw error if tool object is missing in result', async () => {
            mockPost.mockResolvedValue({
                data: { jsonrpc: '2.0', id: 'test-uuid-123', result: { /* no tool object */ } },
                status: 200
            });
            await expect(client._sendRpcRequest('tools/call', 'test-tool', {}))
                .rejects.toThrow("Context7 RPC Response: Missing 'tool' object in result.");
        });

        test('should return undefined if tool.result is missing (for tools that might not have one)', async () => {
             mockPost.mockResolvedValue({
                data: {
                    jsonrpc: '2.0',
                    id: 'test-uuid-123',
                    result: {
                        tool: { name: 'test-tool' /* no result field */ }
                    }
                },
                status: 200
            });
            const result = await client._sendRpcRequest('tools/call', 'test-tool', {});
            expect(result).toBeUndefined();
        });

        test('should handle HTTP error from axios', async () => {
            const errorResponse = { status: 500, data: { message: 'Internal Server Error' } };
            mockPost.mockRejectedValue({ response: errorResponse, request: {}, message: 'Request failed' });
            await expect(client._sendRpcRequest('tools/call', 'test-tool', {}))
                .rejects.toThrow('Context7Client: Failed to call tool \'test-tool\'. HTTP Status 500. Response: {"message":"Internal Server Error"}');
        });

        test('should handle network error (no response) from axios', async () => {
            mockPost.mockRejectedValue({ request: {}, message: 'Network Error' });
            await expect(client._sendRpcRequest('tools/call', 'test-tool', {}))
                .rejects.toThrow("Context7Client: Failed to call tool 'test-tool'. No response from server.");
        });
         test('should propagate already formatted Context7 RPC Error', async () => {
            const rpcError = new Error('Context7 RPC Error (Tool: some-tool): Specific RPC failure (Code: -32001)');
            mockPost.mockRejectedValue(rpcError);
             await expect(client._sendRpcRequest('tools/call', 'some-tool', {}))
                .rejects.toThrow(rpcError.message);
        });
    });

    describe('resolveLibraryId', () => {
        test('should call _sendRpcRequest with correct tool name and args', async () => {
            const spy = jest.spyOn(client, '_sendRpcRequest');
            spy.mockResolvedValueOnce('resolved/id');

            const result = await client.resolveLibraryId('React');

            expect(spy).toHaveBeenCalledWith('tools/call', 'resolve-library-id', { libraryName: 'React' });
            expect(result).toBe('resolved/id');
            spy.mockRestore();
        });

        test('should throw if libraryName is empty', async () => {
            await expect(client.resolveLibraryId('')).rejects.toThrow('Context7Client.resolveLibraryId: libraryName must be a non-empty string.');
        });

        test('should throw if result is not a string', async () => {
            const spy = jest.spyOn(client, '_sendRpcRequest');
            spy.mockResolvedValueOnce({ not: "a string" });
            await expect(client.resolveLibraryId('Lib')).rejects.toThrow('Context7Client.resolveLibraryId: Unexpected result type for library ID of "Lib". Expected string, got object.');
            spy.mockRestore();
        });
    });

    describe('getLibraryDocs', () => {
        test('should call _sendRpcRequest with correct tool name and args (with topic)', async () => {
            const spy = jest.spyOn(client, '_sendRpcRequest');
            spy.mockResolvedValueOnce('Some documentation content.');

            const result = await client.getLibraryDocs('resolved/id', 'hooks', 2000);

            expect(spy).toHaveBeenCalledWith('tools/call', 'get-library-docs', {
                context7CompatibleLibraryID: 'resolved/id',
                topic: 'hooks',
                tokens: 2000
            });
            expect(result).toBe('Some documentation content.');
            spy.mockRestore();
        });

        test('should call _sendRpcRequest without topic if not provided', async () => {
            const spy = jest.spyOn(client, '_sendRpcRequest');
            spy.mockResolvedValueOnce('General docs.');

            await client.getLibraryDocs('resolved/id', null, 3000);

            expect(spy).toHaveBeenCalledWith('tools/call', 'get-library-docs', {
                context7CompatibleLibraryID: 'resolved/id',
                tokens: 3000
                // topic should not be present
            });
             expect(spy.mock.calls[0][2].topic).toBeUndefined();
            spy.mockRestore();
        });

        test('should throw if libraryId is empty', async () => {
            await expect(client.getLibraryDocs('')).rejects.toThrow('Context7Client.getLibraryDocs: libraryId must be a non-empty string.');
        });

        test('should throw if result is not a string', async () => {
            const spy = jest.spyOn(client, '_sendRpcRequest');
            spy.mockResolvedValueOnce(12345); // Not a string
            await expect(client.getLibraryDocs('id')).rejects.toThrow('Context7Client.getLibraryDocs: Unexpected result type for documentation of ID "id". Expected string, got number.');
            spy.mockRestore();
        });
    });
});
