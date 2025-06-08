import type React from "react";
import type {{ Message }} from "@langchain/langgraph-sdk";
import {{ ScrollArea }} from "@/components/ui/scroll-area";
import {{ Loader2, Copy, CopyCheck, Download }} from "lucide-react"; // Added Download icon
import {{ InputForm }} from "@/components/InputForm";
import {{ Button }} from "@/components/ui/button";
import {{ useState, ReactNode }} from "react";
import ReactMarkdown from "react-markdown";
import {{ cn }} from "@/lib/utils";
import {{ Badge }} from "@/components/ui/badge";
import {{
  ActivityTimeline,
  ProcessedEvent,
}} from "@/components/ActivityTimeline";

const mdComponents = {{
  // ... (mdComponents definition remains the same) ...
}};

interface HumanMessageBubbleProps {{
  message: Message;
  mdComponents: typeof mdComponents;
}}

const HumanMessageBubble: React.FC<HumanMessageBubbleProps> = ({{
  message,
  mdComponents,
}}) => {{
  // ... (HumanMessageBubble implementation remains the same) ...
}};

interface AiMessageBubbleProps {{
  message: Message;
  historicalActivity: ProcessedEvent[] | undefined;
  liveActivity: ProcessedEvent[] | undefined;
  isLastMessage: boolean;
  isOverallLoading: boolean;
  mdComponents: typeof mdComponents;
  handleCopy: (text: string, messageId: string) => void;
  copiedMessageId: string | null;
  threadId?: string; // Added
  onDownloadBiography: () => void; // Added
}}

const AiMessageBubble: React.FC<AiMessageBubbleProps> = ({{
  message,
  historicalActivity,
  liveActivity,
  isLastMessage,
  isOverallLoading,
  mdComponents,
  handleCopy,
  copiedMessageId,
  threadId, // Added
  onDownloadBiography, // Added
}}) => {{
  const activityForThisBubble =
    isLastMessage && isOverallLoading ? liveActivity : historicalActivity;
  const isLiveActivityForThisBubble = isLastMessage && isOverallLoading;

  return (
    <div className={{f`relative break-words flex flex-col`}}>
      {{activityForThisBubble && activityForThisBubble.length > 0 && (
        <div className="mb-3 border-b border-neutral-700 pb-3 text-xs">
          <ActivityTimeline
            processedEvents={{activityForThisBubble}}
            isLoading={{isLiveActivityForThisBubble}}
          />
        </div>
      )}}
      <ReactMarkdown components={{mdComponents}}>
        {{typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)}}
      </ReactMarkdown>
      <div className="flex justify-end mt-2"> {/* Added a flex container for buttons */}
        <Button
          variant="default"
          className="cursor-pointer bg-neutral-700 border-neutral-600 text-neutral-300"
          onClick={{() =>
            handleCopy(
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
              message.id!
            )
          }}
        >
          {{copiedMessageId === message.id ? <CopyCheck className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}}
          {{copiedMessageId === message.id ? "Copied" : "Copy"}}
        </Button>
        {{/* Correctly escaped f-string for TSX conditional rendering below */}}
        {{isLastMessage && !isOverallLoading && threadId && (
          <Button
            variant="default"
            className="ml-2 cursor-pointer bg-blue-600 hover:bg-blue-700 text-white"
            onClick={{onDownloadBiography}}
          >
            <Download className="h-4 w-4 mr-1" /> {/* Added Download Icon */}
            Download Biography
          </Button>
        )}}
      </div>
    </div>
  );
}};

interface ChatMessagesViewProps {{
  messages: Message[];
  isLoading: boolean;
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
  onSubmit: (inputValue: string, effort: string, model: string) => void;
  onCancel: () => void;
  liveActivityEvents: ProcessedEvent[];
  historicalActivities: Record<string, ProcessedEvent[]>;
  threadId?: string; // Added
  onDownloadBiography: () => void; // Added
}}

export function ChatMessagesView({{
  messages,
  isLoading,
  scrollAreaRef,
  onSubmit,
  onCancel,
  liveActivityEvents,
  historicalActivities,
  threadId, // Added
  onDownloadBiography, // Added
}}: ChatMessagesViewProps) {{
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const handleCopy = async (text: string, messageId: string) => {{
    // ... (handleCopy implementation remains the same) ...
  }};

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-grow" ref={{scrollAreaRef}}>
        <div className="p-4 md:p-6 space-y-2 max-w-4xl mx-auto pt-16">
          {{messages.map((message, index) => {{
            const isLast = index === messages.length - 1;
            return (
              <div key={{message.id || f`msg-${{index}}`}} className="space-y-3">
                <div
                  className={{f`flex items-start gap-3 ${{
                    message.type === "human" ? "justify-end" : ""
                  }}`}}
                >
                  {{message.type === "human" ? (
                    <HumanMessageBubble
                      message={{message}}
                      mdComponents={{mdComponents}}
                    />
                  ) : (
                    <AiMessageBubble
                      message={{message}}
                      historicalActivity={{historicalActivities[message.id!]}}
                      liveActivity={{liveActivityEvents}}
                      isLastMessage={{isLast}}
                      isOverallLoading={{isLoading}}
                      mdComponents={{mdComponents}}
                      handleCopy={{handleCopy}}
                      copiedMessageId={{copiedMessageId}}
                      threadId={{threadId}} // Added
                      onDownloadBiography={{onDownloadBiography}} // Added
                    />
                  )}}
                </div>
              </div>
            );
          }})}}
          {/* ... (isLoading indicator remains the same) ... */}
        </div>
      </ScrollArea
      <InputForm
        onSubmit={{onSubmit}}
        isLoading={{isLoading}}
        onCancel={{onCancel}}
        hasHistory={{messages.length > 0}}
      />
    </div>
  );
}}
