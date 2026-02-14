import { useState } from 'react';
import { setApiKey } from '../services/api';

interface AuthGateProps {
  onAuthenticated: () => void;
}

export default function AuthGate({ onAuthenticated }: AuthGateProps) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;

    setLoading(true);
    setError('');

    // Temporarily set the key and test it with a lightweight request
    setApiKey(key.trim());
    try {
      const res = await fetch('/api/health', {
        headers: { 'X-API-Key': key.trim() },
      });
      if (res.ok) {
        onAuthenticated();
      } else {
        setError('Invalid API key');
      }
    } catch {
      setError('Could not connect to server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#0a0e2a', zIndex: 99999,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: '#151a3a', borderRadius: 12, padding: '2rem',
        width: '100%', maxWidth: 360, color: '#fff', textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem', fontWeight: 600 }}>Prevue</h2>
        <p style={{ margin: '0 0 1.5rem', color: '#8890b5', fontSize: '0.875rem' }}>
          Enter your API key to continue
        </p>
        <input
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="API Key"
          autoFocus
          style={{
            width: '100%', padding: '0.75rem 1rem', borderRadius: 8,
            border: '1px solid #2a3060', background: '#0d1130', color: '#fff',
            fontSize: '1rem', outline: 'none', boxSizing: 'border-box',
          }}
        />
        {error && (
          <p style={{ color: '#ef4444', margin: '0.75rem 0 0', fontSize: '0.875rem' }}>{error}</p>
        )}
        <button
          type="submit"
          disabled={loading || !key.trim()}
          style={{
            marginTop: '1rem', width: '100%', padding: '0.75rem',
            borderRadius: 8, border: 'none', background: '#3b5bdb',
            color: '#fff', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
            opacity: loading || !key.trim() ? 0.5 : 1,
          }}
        >
          {loading ? 'Verifying...' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
