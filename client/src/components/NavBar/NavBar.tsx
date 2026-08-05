import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Television, GearSix } from '@phosphor-icons/react';
import { useProfile } from '../../contexts/ProfileContext';
import { Avatar } from '../Profile/ProfilePage';
import { useNavZone, useNavigation, moveFocus, arrowToDirection, focusFirst } from '../../navigation';
import './NavBar.css';

// The pills are <Link> anchors, not buttons — the default focus-group selector
// (button/input/select/textarea/[tabindex="0"]) doesn't match them.
const PILL_SELECTOR = 'a[href]';

/**
 * The floating pill bar above the guide preview: Profile / Guide / Settings.
 * Never rendered over fullscreen video.
 */
export default function NavBar() {
  const location = useLocation();
  const { activeProfile } = useProfile();
  const { activeZone, setActiveZone } = useNavigation();
  const navRef = useRef<HTMLElement>(null);
  const hidden = /^\/channel\/\d+$/.test(location.pathname);

  useNavZone({
    id: 'navbar',
    onArrow: (dir) => {
      if (hidden || !navRef.current) return false;
      const d = arrowToDirection(dir, 'horizontal');
      if (d) {
        return moveFocus(navRef.current, d, {
          orientation: 'horizontal',
          wrap: true,
          selector: PILL_SELECTOR,
        });
      }
      return false;
    },
    getAdjacentZone: (dir) => (dir === 'down' ? 'guide-grid' : null),
  });

  // When transitioning into the nav bar (e.g. Up from the guide header), focus the first pill.
  useEffect(() => {
    if (!hidden && activeZone === 'navbar' && navRef.current) {
      focusFirst(navRef.current, PILL_SELECTOR);
    }
  }, [hidden, activeZone]);

  if (hidden) return null;

  const path = location.pathname;
  const current = (target: string) => (path === target ? 'page' : undefined);

  return (
    <nav
      className="navbar"
      aria-label="Main"
      ref={navRef}
      onFocus={() => setActiveZone('navbar')}
    >
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
