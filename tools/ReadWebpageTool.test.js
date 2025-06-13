const ReadWebpageTool = require('./ReadWebpageTool');
const axios = require('axios');
const cheerio = require('cheerio');

jest.mock('axios');

describe('ReadWebpageTool', () => {
  let readWebpageTool;
  let consoleErrorSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    axios.get.mockReset();
    readWebpageTool = new ReadWebpageTool();
    // Spy on console.error and console.warn to suppress output during tests and allow assertion
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original console.error and console.warn
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('should successfully fetch and parse HTML content', async () => {
    const mockHtml = '<html><head><title>Test Page</title></head><body><p>Hello World</p><span>Some other text</span></body></html>';
    axios.get.mockResolvedValue({ data: mockHtml, headers: { 'content-type': 'text/html' } });

    const result = await readWebpageTool.execute({ url: 'http://example.com' });

    expect(axios.get).toHaveBeenCalledWith('http://example.com', { headers: expect.any(Object) });
    expect(result.error).toBeNull();
    // Current ReadWebpageTool logic with $(tag).after('\n') for block elements like <p>
    // and then .text() and cleaning, results in newline between <p> and <span> content.
    expect(result.result).toBe('Hello World\nSome other text');
  });

  test('should successfully fetch and return JSON content', async () => {
    const mockJson = { key: 'value', data: [1, 2, 3] };
    axios.get.mockResolvedValue({ data: mockJson, headers: { 'content-type': 'application/json' } });

    const result = await readWebpageTool.execute({ url: 'http://example.com/data.json' });

    expect(axios.get).toHaveBeenCalledWith('http://example.com/data.json', { headers: expect.any(Object) });
    expect(result.error).toBeNull();
    expect(result.result).toBe(JSON.stringify(mockJson));
  });

  test('should handle network errors when fetching content', async () => {
    axios.get.mockRejectedValue(new Error('Network Error'));

    const result = await readWebpageTool.execute({ url: 'http://example.com' });

    expect(axios.get).toHaveBeenCalledWith('http://example.com', { headers: expect.any(Object) });
    expect(result.result).toBeNull();
    expect(result.error).toContain('Network Error');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('should handle non-HTML/JSON content type by trying to parse as text', async () => {
    const mockTextData = 'This is plain text content.';
    axios.get.mockResolvedValue({ data: mockTextData, headers: { 'content-type': 'text/plain' } });

    const result = await readWebpageTool.execute({ url: 'http://example.com/file.txt' });

    expect(result.error).toBeNull();
    // Cheerio wraps plain text in <html><body><p>...</p></body></html>, .after('\n') on p, then .text()
    expect(result.result).toBe('This is plain text content.');
  });

  test('should return an error for invalid input (e.g., no URL)', async () => {
    const result = await readWebpageTool.execute({});
    expect(result.result).toBeNull();
    expect(result.error).toBe("Invalid input for ReadWebpageTool: 'url' string is required.");

    const result2 = await readWebpageTool.execute({ url: "" });
    expect(result2.result).toBeNull();
    expect(result2.error).toBe("Invalid input for ReadWebpageTool: 'url' string is required.");
  });

  test('should handle HTTP error status codes', async () => {
    const errorResponse = {
      message: 'Request failed with status code 404',
      response: { status: 404, data: 'Page Not Found' }
    };
    axios.get.mockRejectedValue(errorResponse);

    const result = await readWebpageTool.execute({ url: 'http://example.com/notfound' });

    expect(result.result).toBeNull();
    expect(result.error).toContain('Failed to read webpage: Request failed with status code 404 (Status: 404)');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('should correctly clean extracted text (extra spaces, newlines)', async () => {
    const mockHtmlWithSpaces = '<html><body><p>  Hello   World  </p>\n\n<p>Another line</p></body></html>';
    axios.get.mockResolvedValue({ data: mockHtmlWithSpaces, headers: { 'content-type': 'text/html' } });

    const result = await readWebpageTool.execute({ url: 'http://example.com/spaced.html' });

    expect(result.error).toBeNull();
    // <p>Hello World</p>\n<p>Another line</p>\n -> "Hello World \n Another line \n" -> cleaned
    expect(result.result).toBe('Hello World\nAnother line');
  });

  test('should handle cases where htmlContent is not a string or object', async () => {
    axios.get.mockResolvedValue({ data: 12345, headers: { 'content-type': 'text/html' } });

    const result = await readWebpageTool.execute({ url: 'http://example.com/unexpected' });

    expect(result.result).toBeNull();
    expect(result.error).toBe('Failed to read webpage: unexpected content type.');
    expect(consoleWarnSpy).toHaveBeenCalled();
  });
});
