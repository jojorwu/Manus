const express = require('express');
const path = require('path'); // Added for serving static files
const app = express();
const port = 3000;

// Middleware to parse JSON bodies and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the root directory (e.g., style.css)
app.use(express.static(__dirname));

// GET endpoint to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// POST endpoint for downloading biography
app.post('/api/download-biography', (req, res) => {
  const name = req.body.name;
  if (!name) {
    return res.status(400).json({ message: "Name is required" });
  }
  res.json({ message: `Processing biography for: ${name}`, receivedName: name });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
