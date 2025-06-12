const AdvancedWebpageReaderTool = require('./AdvancedWebpageReaderTool');
const playwright = require('playwright'); // Actual playwright for type, but it will be mocked

// Simplified Playwright Mock - This will be the base mock.
// Individual tests can override parts of this for specific scenarios.
const mockPage = {
  goto: jest.fn().mockResolvedValue(undefined),
  content: jest.fn().mockResolvedValue('<html><body><p>Default Mocked Content</p><img src="/img.png" alt="Test Image"><img src="http://example.com/absimg.png" alt="Absolute Image"></body></html>'),
  close: jest.fn().mockResolvedValue(undefined),
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
    // Reset mocks before each test to clear call counts and previous specific mock implementations
    playwright.chromium.launch.mockClear().mockResolvedValue(mockBrowser); // Reset to default mock
    mockBrowser.newContext.mockClear().mockResolvedValue(mockContext);
    mockBrowser.close.mockClear().mockResolvedValue(undefined);
    mockContext.newPage.mockClear().mockResolvedValue(mockPage);
    mockContext.close.mockClear().mockResolvedValue(undefined);
    mockPage.goto.mockClear().mockResolvedValue(undefined);
    mockPage.content.mockClear().mockResolvedValue('<html><body><p>Default Mocked Content</p><img src="/img.png" alt="Test Image"><img src="http://example.com/absimg.png" alt="Absolute Image"></body></html>');
    mockPage.close.mockClear().mockResolvedValue(undefined);

    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    tool = new AdvancedWebpageReaderTool();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('should successfully extract text and image information from mocked HTML', async () => {
    const testUrl = 'http://example.com/testpage';
    // Ensure default mockPage.content is used or set it explicitly if needed for this test
    mockPage.content.mockResolvedValue('<html><body><p>Mocked Content</p><img src="/img.png" alt="Test Image"><img src="http://example.com/absimg.png" alt="Absolute Image"></body></html>');
    const result = await tool.execute({ url: testUrl });

    expect(playwright.chromium.launch).toHaveBeenCalledTimes(1);
    expect(mockPage.goto).toHaveBeenCalledWith(testUrl, { waitUntil: 'networkidle', timeout: 60000 });
    expect(mockPage.content).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.url).toBe(testUrl);
    expect(result.text).toBe('Mocked Content');
    expect(result.images).toEqual([
      { src: 'http://example.com/img.png', alt: 'Test Image' },
      { src: 'http://example.com/absimg.png', alt: 'Absolute Image' },
    ]);
    expect(result.htmlContentPreview).toContain('&lt;html&gt;&lt;body&gt;&lt;p&gt;Mocked Content&lt;/p&gt;');
  });

  test('should extract text from <article> tag if present', async () => {
    mockPage.content.mockResolvedValue('<html><body><article>Article content here. <p>Nested paragraph.</p></article><footer>Footer</footer></body></html>');
    const result = await tool.execute({ url: 'http://example.com/article' });
    expect(result.text).toBe('Article content here. Nested paragraph.');
  });

  test('should extract text from <main> tag if present and <article> is not', async () => {
    mockPage.content.mockResolvedValue('<html><body><main>Main area. <span>Span inside main.</span></main><footer>Footer</footer></body></html>');
    const result = await tool.execute({ url: 'http://example.com/main' });
    expect(result.text).toBe('Main area. Span inside main.');
  });

  test('should handle HTML with no specific main content tags, falling back to body', async () => {
    mockPage.content.mockResolvedValue('<html><body><div>Generic div content.</div><span>Sibling span.</span></body></html>');
    const result = await tool.execute({ url: 'http://example.com/generic' });
    expect(result.text).toBe('Generic div content. Sibling span.');
  });

  test('should correctly resolve relative image URLs from a deeper base URL', async () => {
    const testUrl = 'http://example.com/path/to/page.html';
    mockPage.content.mockResolvedValue('<html><body><img src="../images/pic.png" alt="Relative Pic"></body></html>');
    const result = await tool.execute({ url: testUrl });
    expect(result.images).toEqual([
      { src: 'http://example.com/path/images/pic.png', alt: 'Relative Pic' },
    ]);
  });

  test('should handle data URI images', async () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA';
    mockPage.content.mockResolvedValue(`<html><body><img src="${dataUri}" alt="Data URI Image"></body></html>`);
    const result = await tool.execute({ url: 'http://example.com/datauri' });
    expect(result.images).toEqual([
      { src: dataUri, alt: 'Data URI Image' },
    ]);
  });


  test('should handle HTML with no images', async () => {
    mockPage.content.mockResolvedValue('<html><body><p>No images here</p></body></html>');
    const result = await tool.execute({ url: 'http://example.com/noimages' });
    expect(result.success).toBe(true);
    expect(result.text).toBe('No images here');
    expect(result.images).toEqual([]);
  });

  test('should handle empty HTML content (body only)', async () => {
    mockPage.content.mockResolvedValue('<html><body></body></html>');
    const result = await tool.execute({ url: 'http://example.com/empty' });
    expect(result.success).toBe(true);
    expect(result.text).toBe('');
    expect(result.images).toEqual([]);
  });

  test('should handle images with missing alt attributes', async () => {
    mockPage.content.mockResolvedValue('<html><body><img src="no-alt.png"></body></html>');
    const result = await tool.execute({ url: 'http://example.com/no-alt' });
    expect(result.success).toBe(true);
    expect(result.images).toEqual([
      { src: 'http://example.com/no-alt.png', alt: '' },
    ]);
  });

  test('should handle playwright launch error', async () => {
    playwright.chromium.launch.mockRejectedValueOnce(new Error('Launch failed'));
    const result = await tool.execute({ url: 'http://example.com/launch-error' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to load or process page');
    expect(result.details).toBe('Launch failed');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('should handle browser.newContext error', async () => {
    mockBrowser.newContext.mockRejectedValueOnce(new Error('Context creation failed'));
    const result = await tool.execute({ url: 'http://example.com/context-error' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to load or process page');
    expect(result.details).toBe('Context creation failed');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('should handle page.newPage error', async () => {
    mockContext.newPage.mockRejectedValueOnce(new Error('Page creation failed'));
    const result = await tool.execute({ url: 'http://example.com/newpage-error' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to load or process page');
    expect(result.details).toBe('Page creation failed');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('should handle page.goto error', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Navigation failed'));
    const result = await tool.execute({ url: 'http://example.com/goto-error' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to load or process page');
    expect(result.details).toBe('Navigation failed');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('should handle page.content error', async () => {
    mockPage.content.mockRejectedValueOnce(new Error('Content retrieval failed'));
    const result = await tool.execute({ url: 'http://example.com/content-error' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to load or process page');
    expect(result.details).toBe('Content retrieval failed');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('should handle invalid URL input', async () => {
    const result = await tool.execute({ url: '' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid URL');
    expect(result.details).toBe('URL string is required.');
    expect(consoleErrorSpy).toHaveBeenCalled(); // The tool logs an error for invalid URL
  });

  test('should return empty text for HTML with only tags but no text content', async () => {
    mockPage.content.mockResolvedValue('<html><body><img src="an_image.png"><div><span></span></div></body></html>');
    const result = await tool.execute({ url: 'http://example.com/no-text-elements' });
    expect(result.success).toBe(true);
    expect(result.text).toBe('');
    expect(result.images.length).toBe(1);
  });

});
