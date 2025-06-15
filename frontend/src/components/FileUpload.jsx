import React, { useState, useCallback, useId } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input"; // Although hidden, it's good practice to list imports
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { XCircle, Paperclip, Trash2 } from 'lucide-react';

const formatFileSize = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

function FileUpload({
  onFilesChange,
  maxFiles = 5,
  maxFileSizeMB = 10,
  instanceId = 'default'
}) {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [error, setError] = useState('');
  const componentId = useId();
  const fileInputId = `file-upload-${componentId}-${instanceId}`;
  const maxSizeBytes = maxFileSizeMB * 1024 * 1024;

  const handleFileChange = useCallback((event) => {
    setError('');
    const newFiles = Array.from(event.target.files);
    let currentFiles = [...selectedFiles];
    let addedCount = 0;

    for (const file of newFiles) {
      if (currentFiles.length + addedCount >= maxFiles) {
        setError(`Максимум ${maxFiles} файлов.`);
        break;
      }
      if (file.size > maxSizeBytes) {
        setError(`Файл "${file.name}" слишком большой (макс. ${maxFileSizeMB}MB).`);
        continue;
      }
      if (currentFiles.find(f => f.name === file.name)) {
        // Skip duplicate by name, could also add error/warning
        console.warn(`File "${file.name}" is already selected.`);
        continue;
      }
      currentFiles.push(file);
      addedCount++;
    }

    // In case some files were skipped due to errors, but some were valid and added
    // ensure we don't exceed maxFiles with the successfully added ones.
    // This logic is slightly complex due to batch additions; simpler if adding one by one.
    // The loop break above handles the primary maxFiles check.
    // This slice ensures if a batch pushes over, it's trimmed.
    if (currentFiles.length > maxFiles) {
        currentFiles = currentFiles.slice(0, maxFiles);
        setError(`Максимум ${maxFiles} файлов. Некоторые файлы не были добавлены.`);
    }

    setSelectedFiles(currentFiles);
    if (onFilesChange) {
      onFilesChange(currentFiles);
    }
    event.target.value = null; // Reset input to allow re-selecting same file after removal
  }, [selectedFiles, maxFiles, maxSizeBytes, maxFileSizeMB, onFilesChange]);

  const handleRemoveFile = useCallback((fileName) => {
    const updatedFiles = selectedFiles.filter(file => file.name !== fileName);
    setSelectedFiles(updatedFiles);
    if (onFilesChange) {
      onFilesChange(updatedFiles);
    }
    // Clear error if it was about max files and now it's valid
    if (error.startsWith("Максимум") && updatedFiles.length < maxFiles) {
      setError('');
    }
  }, [selectedFiles, onFilesChange, error, maxFiles]);

  return (
    <div className="space-y-3 w-full">
      <Input
        type="file"
        multiple
        onChange={handleFileChange}
        id={fileInputId}
        className="hidden"
        accept="*" // Or specify more restrictive types e.g. "image/*,.pdf"
      />
      <Button type="button" onClick={() => document.getElementById(fileInputId)?.click()} variant="outline">
        <Paperclip className="mr-2 h-4 w-4" />
        Прикрепить файлы (макс. {maxFiles}, до {maxFileSizeMB}MB)
      </Button>

      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Ошибка</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {selectedFiles.length > 0 && (
        <ScrollArea className="h-40 w-full rounded-md border p-3">
          <div className="space-y-2">
            {selectedFiles.map((file) => (
              <div key={file.name} className="flex items-center justify-between p-2 rounded-md border bg-muted/20 hover:bg-muted/50">
                <div className="flex flex-col text-sm">
                  <span className="font-medium truncate max-w-xs" title={file.name}>{file.name}</span>
                  <span className="text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemoveFile(file.name)}
                  aria-label={`Remove ${file.name}`}
                >
                  <Trash2 className="h-4 w-4 text-red-500 hover:text-red-700" />
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

export default FileUpload;
