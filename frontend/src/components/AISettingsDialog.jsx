import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

const initialSettings = {
  activeService: 'openai',
  services: {
    openai: {
      defaultModel: 'gpt-3.5-turbo',
      temperature: 0.7,
      maxTokens: 2048,
      systemMessage: 'You are a helpful assistant.',
      stopSequences: [], // Store as array, edit as comma-separated string
      topP: 1.0
    },
    gemini: {
      defaultModel: 'gemini-pro',
      temperature: 0.7,
      maxTokens: 2048,
      systemInstruction: 'You are a helpful AI assistant.',
      stopSequences: [] // Store as array, edit as comma-separated string
    }
  }
};

function AISettingsDialog({ isOpen, onOpenChange, onSettingsSave }) {
  const [settings, setSettings] = useState(null);
  const [currentActiveService, setCurrentActiveService] = useState(initialSettings.activeService);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const fetchSettings = useCallback(async () => {
    if (!isOpen) return;
    setIsLoading(true);
    setError('');
    setSuccessMessage('');
    try {
      const response = await axios.get('/api/ai-settings');
      setSettings(response.data);
      setCurrentActiveService(response.data.activeService || initialSettings.activeService);
    } catch (err) {
      console.error("Failed to fetch AI settings:", err);
      setError('Failed to load settings. Using defaults.');
      setSettings(JSON.parse(JSON.stringify(initialSettings))); // Deep copy
      setCurrentActiveService(initialSettings.activeService);
    } finally {
      setIsLoading(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      fetchSettings();
    } else {
      // Reset messages when dialog is closed
      setError('');
      setSuccessMessage('');
    }
  }, [isOpen, fetchSettings]);

  const handleActiveServiceChange = (serviceKey) => {
    setCurrentActiveService(serviceKey);
    setSettings(prev => ({ ...prev, activeService: serviceKey }));
  };

  const handleServiceSettingChange = (field, value) => {
    // For numeric fields, convert value to number
    const numericFields = ['temperature', 'maxTokens', 'topP'];
    let processedValue = value;
    if (numericFields.includes(field)) {
      processedValue = parseFloat(value);
      if (isNaN(processedValue)) processedValue = 0; // or some default/validation
    }

    setSettings(prev => ({
      ...prev,
      services: {
        ...prev.services,
        [currentActiveService]: {
          ...prev.services[currentActiveService],
          [field]: processedValue
        }
      }
    }));
  };

  const handleStopSequencesChange = (value) => {
    // Kept as string in UI, will be parsed on save
     setSettings(prev => ({
      ...prev,
      services: {
        ...prev.services,
        [currentActiveService]: {
          ...prev.services[currentActiveService],
          // Temporarily store as string for input field, parse on save
          stopSequencesDisplay: value
        }
      }
    }));
  };


  const prepareSettingsForSave = () => {
    const settingsToSave = JSON.parse(JSON.stringify(settings)); // Deep copy
    const serviceSettings = settingsToSave.services[currentActiveService];

    if (serviceSettings && typeof serviceSettings.stopSequencesDisplay === 'string') {
      serviceSettings.stopSequences = serviceSettings.stopSequencesDisplay
        .split(',')
        .map(s => s.trim())
        .filter(s => s !== '');
      delete serviceSettings.stopSequencesDisplay; // remove temporary display field
    }
    return settingsToSave;
  };


  const handleSaveSettings = async () => {
    setIsLoading(true);
    setError('');
    setSuccessMessage('');
    const settingsToSave = prepareSettingsForSave();

    try {
      await axios.post('/api/ai-settings', settingsToSave);
      setSettings(settingsToSave); // Update local state with parsed sequences
      setSuccessMessage('AI settings saved successfully!');
      if (onSettingsSave) {
        onSettingsSave(settingsToSave);
      }
      setTimeout(() => { // Optionally close dialog after a delay
        onOpenChange(false);
      }, 1500);
    } catch (err) {
      console.error("Failed to save AI settings:", err);
      setError(err.response?.data?.message || 'Failed to save settings.');
    } finally {
      setIsLoading(false);
    }
  };

  // Effect to initialize stopSequencesDisplay when settings or currentActiveService changes
  useEffect(() => {
    if (settings && settings.services && settings.services[currentActiveService]) {
      const currentStopSequences = settings.services[currentActiveService].stopSequences || [];
      handleServiceSettingChange('stopSequencesDisplay', currentStopSequences.join(', '));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.services[currentActiveService]?.stopSequences, currentActiveService]);


  const currentServiceSettings = settings ? settings.services[currentActiveService] : null;
  const systemInstructionLabel = currentActiveService === 'openai' ? 'System Message' : 'System Instruction';

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI Service Configuration</DialogTitle>
          <DialogDescription>
            Manage and select the active AI service and its settings.
          </DialogDescription>
        </DialogHeader>

        {isLoading && !settings && (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="ml-2">Loading settings...</p>
          </div>
        )}

        {error && !isLoading && !settings && ( // Show error if initial load fails
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {settings && (
          <ScrollArea className="max-h-[60vh] p-1">
            <div className="space-y-6 pr-4">
              <div className="space-y-2">
                <Label htmlFor="active-service-select">Active AI Service</Label>
                <Select value={currentActiveService} onValueChange={handleActiveServiceChange}>
                  <SelectTrigger id="active-service-select">
                    <SelectValue placeholder="Select a service" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(settings.services).map(key => (
                      <SelectItem key={key} value={key}>{key.charAt(0).toUpperCase() + key.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {currentServiceSettings && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="defaultModel">Default Model</Label>
                      <Input
                        id="defaultModel"
                        value={currentServiceSettings.defaultModel || ''}
                        onChange={(e) => handleServiceSettingChange('defaultModel', e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="temperature">Temperature</Label>
                      <Input
                        id="temperature"
                        type="number"
                        min="0" max="2" step="0.1"
                        value={currentServiceSettings.temperature || 0}
                        onChange={(e) => handleServiceSettingChange('temperature', e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="maxTokens">Max Tokens</Label>
                      <Input
                        id="maxTokens"
                        type="number"
                        min="1"
                        value={currentServiceSettings.maxTokens || 0}
                        onChange={(e) => handleServiceSettingChange('maxTokens', e.target.value)}
                      />
                    </div>
                    {currentActiveService === 'openai' && (
                       <div className="space-y-2">
                        <Label htmlFor="topP">Top P</Label>
                        <Input
                          id="topP"
                          type="number"
                          min="0" max="1" step="0.01"
                          value={currentServiceSettings.topP || 0}
                          onChange={(e) => handleServiceSettingChange('topP', e.target.value)}
                        />
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="systemInstruction">{systemInstructionLabel}</Label>
                    <Textarea
                      id="systemInstruction"
                      value={currentServiceSettings.systemMessage || currentServiceSettings.systemInstruction || ''}
                      onChange={(e) => handleServiceSettingChange(currentActiveService === 'openai' ? 'systemMessage' : 'systemInstruction', e.target.value)}
                      placeholder={`Enter ${systemInstructionLabel.toLowerCase()}...`}
                      className="min-h-[100px]"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="stopSequences">Stop Sequences (comma-separated)</Label>
                    <Input
                      id="stopSequences"
                      value={currentServiceSettings.stopSequencesDisplay || ''}
                      onChange={(e) => handleStopSequencesChange(e.target.value)}
                      placeholder="e.g. ###,STOP,..."
                    />
                  </div>
                </>
              )}

              {error && (
                <Alert variant="destructive" className="mt-4">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {successMessage && (
                <Alert variant="default" className="mt-4 bg-green-100 dark:bg-green-800/30 border-green-500 dark:border-green-700">
                  <CheckCircle2 className="h-4 w-4 text-green-700 dark:text-green-500" />
                  <AlertTitle className="text-green-800 dark:text-green-400">Success</AlertTitle>
                  <AlertDescription className="text-green-700 dark:text-green-300">{successMessage}</AlertDescription>
                </Alert>
              )}
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="pt-4">
          <DialogClose asChild>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          </DialogClose>
          <Button onClick={handleSaveSettings} disabled={isLoading || !settings}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AISettingsDialog;
