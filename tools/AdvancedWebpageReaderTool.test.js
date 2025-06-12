const AdvancedWebpageReaderTool = require('./AdvancedWebpageReaderTool');
const playwright = require('playwright');

// Refined Playwright Mock Structure
const mockPageEvaluate = jest.fn();
const mockResponseHeaders = jest.fn();

const mockPage = {
  goto: jest.fn(), // Will resolve to an object with a headers method
  content: jest.fn().mockResolvedValue('<html><body><p>Default Mocked Content</p></body></html>'),
  evaluate: mockPageEvaluate,
  close: jest.fn().mockResolvedValue(undefined),
  textContent: jest.fn() // Added for fallback text extraction
};
const mockContext = {
  newPage: jest.fn().mockResolvedValue(mockPage),
  close: jest.fn().mockResolvedValue(undefined),
};
const mockBrowser = {
  newContext: jest.fn().mockResolvedValue(mockContext),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue(mockBrowser),
  },
}));

describe('AdvancedWebpageReaderTool', () => {
  let tool;
  let consoleErrorSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    playwright.chromium.launch.mockClear().mockResolvedValue(mockBrowser);
    mockBrowser.newContext.mockClear().mockResolvedValue(mockContext);
    mockBrowser.close.mockClear().mockResolvedValue(undefined);
    mockContext.newPage.mockClear().mockResolvedValue(mockPage);
    mockContext.close.mockClear().mockResolvedValue(undefined);

    // Default behavior for page.goto()
    mockPage.goto.mockReset().mockResolvedValue({ headers: mockResponseHeaders });
    mockResponseHeaders.mockReset().mockReturnValue({ 'content-type': 'text/html' }); // Default to HTML

    mockPage.content.mockReset().mockResolvedValue('<html><body><p>Default Mocked Content</p><img src="/img.png" alt="Test Image"><img src="http://example.com/absimg.png" alt="Absolute Image"></body></html>');
    mockPage.evaluate.mockReset();
    mockPage.textContent.mockReset();
    mockPage.close.mockClear().mockResolvedValue(undefined);

    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    tool = new AdvancedWebpageReaderTool();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('should successfully extract text and image information from HTML', async () => {
    const testUrl = 'http://example.com/htmlpage';
    // mockResponseHeaders already defaults to text/html
    mockPage.content.mockResolvedValue('<html><body><p>HTML Content</p><img src="img1.png" alt="Image 1"></body></html>');
    const result = await tool.execute({ url: testUrl });

    expect(result.success).toBe(true);
    expect(result.text).toBe('HTML Content');
    expect(result.images).toEqual([{ src: 'http://example.com/img1.png', alt: 'Image 1' }]);
    expect(result.contentType).toBe('text/html');
  });

  test('should extract text from <article> tag for HTML', async () => {
    mockPage.content.mockResolvedValue('<html><body><article>Article content.</article></body></html>');
    const result = await tool.execute({ url: 'http://example.com/article-html' });
    expect(result.text).toBe('Article content.');
  });

  test('should correctly resolve relative image URLs from a deeper base URL for HTML', async () => {
    const testUrl = 'http://example.com/path/to/page.html';
    mockPage.content.mockResolvedValue('<html><body><img src="../images/pic.png" alt="Relative Pic"></body></html>');
    const result = await tool.execute({ url: testUrl });
    expect(result.images).toEqual([
      { src: 'http://example.com/path/images/pic.png', alt: 'Relative Pic' },
    ]);
  });

  test('should handle data URI images for HTML', async () => {
    const dataUri = 'data:image/png;base64,abc';
    mockPage.content.mockResolvedValue(`<html><body><img src="${dataUri}" alt="Data URI"></body></html>`);
    const result = await tool.execute({ url: 'http://example.com/datauri-html' });
    expect(result.images).toEqual([{ src: dataUri, alt: 'Data URI' }]);
  });

  test('should enhance image URL resolution error message', async () => {
    const testUrl = 'http://example.com/bad-image-url';
    // Simulate an invalid URL that would cause `new URL()` to throw.
    // Note: `URL` constructor is quite permissive. A very malformed URL is needed.
    // Let's assume "http://:invalid" is enough, or that the host environment's URL is stricter.
    // For Jest, `new URL("http://:invalid.com", "http://example.com")` throws "Invalid URL"
    mockPage.content.mockResolvedValue('<html><body><img src="http://:invalid.com" alt="Problematic"></body></html>');
    const result = await tool.execute({ url: testUrl });
    expect(result.success).toBe(true); // Page itself loads
    expect(result.images.length).toBe(1);
    expect(result.images[0].error).toContain('Could not resolve to absolute URL');
    // The exact message "Invalid URL" comes from Node's URL constructor.
    expect(result.images[0].error).toMatch(/Invalid URL|Failed to parse URL/); // Accommodate slight variations
  });

  // Tests for Non-HTML Content
  test('should handle JSON content', async () => {
    const testUrl = 'http://example.com/api/data.json';
    const jsonData = { key: 'value', data: [1, 2, 3] };
    const jsonString = JSON.stringify(jsonData);

    mockResponseHeaders.mockReturnValue({ 'content-type': 'application/json' });
    mockPageEvaluate.mockResolvedValue(jsonString); // Simulates document.body.innerText returning the JSON string

    const result = await tool.execute({ url: testUrl });

    expect(result.success).toBe(true);
    expect(result.contentType).toBe('application/json');
    expect(result.text).toBe(jsonString);
    expect(result.images).toEqual([]);
  });

  test('should handle unparseable JSON content (fallback to text)', async () => {
    const testUrl = 'http://example.com/api/badjson.json';
    const badJsonString = '{key: "value"}'; // Invalid JSON

    mockResponseHeaders.mockReturnValue({ 'content-type': 'application/json' });
    mockPageEvaluate.mockResolvedValue(badJsonString);

    const result = await tool.execute({ url: testUrl });

    expect(result.success).toBe(true);
    expect(result.contentType).toBe('application/json'); // Still reports original type
    expect(result.text).toBe(badJsonString);
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to parse content as JSON'));
  });

  test('should handle plain text content', async () => {
    const testUrl = 'http://example.com/file.txt';
    const plainText = 'This is plain text content.';

    mockResponseHeaders.mockReturnValue({ 'content-type': 'text/plain; charset=utf-8' });
    mockPageEvaluate.mockResolvedValue(plainText);

    const result = await tool.execute({ url: testUrl });

    expect(result.success).toBe(true);
    expect(result.contentType).toBe('text/plain; charset=utf-8');
    expect(result.text).toBe(plainText);
  });

  test('should handle unsupported content type (e.g., PDF)', async () => {
    const testUrl = 'http://example.com/document.pdf';
    mockResponseHeaders.mockReturnValue({ 'content-type': 'application/pdf' });
    mockPageEvaluate.mockResolvedValue('%PDF-1.4...'); // Some sniffed content

    const result = await tool.execute({ url: testUrl });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unsupported content type');
    expect(result.contentType).toBe('application/pdf');
    expect(result.details).toContain("Content-Type is 'application/pdf'");
    expect(result.text).toBe('%PDF-1.4...');
  });

  test('should handle page.goto returning null response (e.g. 204)', async () => {
    const testUrl = 'http://example.com/no-content-204';
    mockPage.goto.mockResolvedValue(null); // Simulate 204 No Content
    mockPage.content.mockResolvedValue("<html><body></body></html>"); // If it tries to get content after null response

    const result = await tool.execute({ url: testUrl });
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('No response object returned by page.goto'));
    // Should default to HTML processing path if no content-type info but content retrieval succeeds
    expect(result.success).toBe(true);
    expect(result.text).toBe(""); // Empty body
    expect(result.contentType).toBe("text/html"); // Default assumption
  });

  // Error Handling tests (from previous set, ensuring they still work with new mock)
  test('should handle playwright launch error', async () => {
    playwright.chromium.launch.mockRejectedValueOnce(new Error('Launch failed'));
    const result = await tool.execute({ url: 'http://example.com/launch-error' });
    expect(result.success).toBe(false);
    expect(result.details).toBe('Launch failed');
  });

  test('should handle page.goto navigation error', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Navigation failed hard'));
    const result = await tool.execute({ url: 'http://example.com/goto-hard-error' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to load or process page');
    expect(result.details).toBe('Navigation failed hard');
  });

  test('should handle page.evaluate error for non-HTML text', async () => {
    const testUrl = 'http://example.com/api/text-eval-error';
    mockResponseHeaders.mockReturnValue({ 'content-type': 'text/plain' });
    mockPage.evaluate.mockRejectedValueOnce(new Error('Eval body.innerText failed'));
    mockPage.textContent.mockResolvedValue("Fallback text content"); // Fallback works

    const result = await tool.execute({ url: testUrl });
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not get document.body.innerText'));
    expect(result.success).toBe(true);
    expect(result.text).toBe("Fallback text content");
  });

  test('should handle all fallbacks failing for non-HTML text', async () => {
    const testUrl = 'http://example.com/api/text-all-fallback-error';
    mockResponseHeaders.mockReturnValue({ 'content-type': 'text/plain' });
    mockPage.evaluate.mockRejectedValueOnce(new Error('Eval body.innerText failed'));
    mockPage.textContent.mockRejectedValueOnce(new Error('page.textContent failed'));
    mockPage.content.mockResolvedValueOnce("Raw page content as last resort"); // Last resort

    const result = await tool.execute({ url: testUrl });
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not get document.body.innerText'));
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not get page.textContent(\'body\')'));
    expect(result.success).toBe(true); // Still true because it "succeeded" in getting *some* text
    expect(result.text).toBe("Raw page content as last resort");
  });

});
