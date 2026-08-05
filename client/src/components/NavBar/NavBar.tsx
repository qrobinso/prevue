import { Link, useLocation } from 'react-router-dom';
import { Television, GearSix } from '@phosphor-icons/react';
import { useProfile } from '../../contexts/ProfileContext';
import { Avatar } from '../Profile/ProfilePage';
import './NavBar.css';

/**
 * The floating pill bar above the guide preview: Profile / Guide / Settings.
 * Never rendered over fullscreen video.
 */
export default function NavBar() {
  const location = useLocation();
  const { activeProfile } = useProfile();

  if (/^\/channel\/\d+$/.test(location.pathname)) return null;

  const path = location.pathname;
  const current = (target: string) => (path === target ? 'page' : undefined);

  return (
    <nav className="navbar" aria-label="Main">
      <Link
        to="/profile"
        className={`navbar-pill ${path === '/profile' ? 'navbar-pill-active' : ''}`}
        aria-current={current('/profile')}
      >
        {activeProfile && <Avatar profile={activeProfile} size={20} />}
        <span>{activeProfile?.name ?? 'Profile'}</span>
      </Link>

      <Link
        to="/"
        className={`navbar-pill ${path === '/' ? 'navbar-pill-active' : ''}`}
        aria-current={current('/')}
      >
        <Television size={16} weight="bold" />
        <span>Guide</span>
      </Link>

      <Link
        to="/settings"
        className={`navbar-pill ${path === '/settings' ? 'navbar-pill-active' : ''}`}
        aria-current={current('/settings')}
      >
        <GearSix size={16} weight="bold" />
        <span>Settings</span>
      </Link>
    </nav>
  );
}
