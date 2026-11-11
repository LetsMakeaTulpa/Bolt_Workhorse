import { forwardRef, useState, KeyboardEvent } from 'react';
import { ArrowUp } from 'lucide-react';

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled: boolean;
}

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(
  ({ onSend, disabled }, _ref) => {
    const [value, setValue] = useState('');

    const handleSend = () => {
      if (!value.trim() || disabled) return;
      onSend(value.trim());
      setValue('');
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    };

    return (
      <div className="relative flex items-end gap-2 rounded-xl border border-border bg-bg-elevated p-1.5 transition-colors focus-within:border-accent/40">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a research question..."
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none bg-transparent px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none disabled:opacity-40"
          style={{ maxHeight: '200px', minHeight: '40px' }}
        />
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent text-bg-base transition-all hover:bg-accent-hover disabled:opacity-25 disabled:cursor-not-allowed"
        >
          <ArrowUp size={16} />
        </button>
      </div>
    );
  }
);

ChatInput.displayName = 'ChatInput';
