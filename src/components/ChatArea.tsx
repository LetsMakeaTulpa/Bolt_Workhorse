import { useRef } from 'react';
import { Message } from '../types';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { WelcomeScreen } from './WelcomeScreen';
import { Globe, Loader2, Compass } from 'lucide-react';

interface ChatAreaProps {
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  onSendMessage: (content: string) => void;
  searchEnabled: boolean;
  isSearching: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  presetName: string;
}

export function ChatArea({
  messages,
  isStreaming,
  onSendMessage,
  searchEnabled,
  isSearching,
  messagesEndRef,
  presetName,
}: ChatAreaProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <WelcomeScreen onSendMessage={onSendMessage} />
        ) : (
          <div className="mx-auto max-w-3xl px-6 py-6">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={isStreaming && msg.id === messages[messages.length - 1]?.id && msg.role === 'assistant'}
              />
            ))}
            {isSearching && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-olive/30 bg-olive-subtle px-4 py-2.5 text-xs text-olive animate-fade-in">
                <Loader2 size={14} className="animate-spin" />
                <span>Searching across multiple engines with semantic query compilation and RRF ranking...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border-subtle bg-bg-surface px-6 py-4">
        <div className="mx-auto max-w-3xl">
          {searchEnabled && (
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-olive">
              <Globe size={11} />
              <span>Web search active — using <span className="font-medium capitalize">{presetName}</span> preset with RRF ranking</span>
            </div>
          )}
          <ChatInput onSend={onSendMessage} disabled={isStreaming || isSearching} />
        </div>
      </div>
    </div>
  );
}
