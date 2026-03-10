import { useState, useEffect } from 'react';
import { Moon } from '@phosphor-icons/react';
import './GoodnightScreen.css';

interface GoodnightScreenProps {
  onDismiss: () => void;
}

export default function GoodnightScreen({ onDismiss }: GoodnightScreenProps) {
  const [time, setTime] = useState(() => formatTime(new Date()));
  const [dimClock, setDimClock] = useState(false);

  // Update clock every second
  useEffect(() => {
    const interval = setInterval(() => {
      setTime(formatTime(new Date()));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Dim the clock after 10 seconds (OLED burn-in protection)
  useEffect(() => {
    const timer = setTimeout(() => setDimClock(true), 10000);
    return () => clearTimeout(timer);
  }, []);

  // Any interaction dismisses
  useEffect(() => {
    const dismiss = () => onDismiss();
    window.addEventListener('keydown', dismiss, { once: true });
    window.addEventListener('click', dismiss, { once: true });
    window.addEventListener('touchstart', dismiss, { once: true });
    return () => {
      window.removeEventListener('keydown', dismiss);
      window.removeEventListener('click', dismiss);
      window.removeEventListener('touchstart', dismiss);
    };
  }, [onDismiss]);

  return (
    <div className="goodnight-screen">
      <div className={`goodnight-content ${dimClock ? 'dimmed' : ''}`}>
        <Moon size={32} weight="light" className="goodnight-icon" />
        <div className="goodnight-time">{time}</div>
        <div className="goodnight-text">Goodnight</div>
        <div className="goodnight-hint">Tap anywhere to resume</div>
      </div>
    </div>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
