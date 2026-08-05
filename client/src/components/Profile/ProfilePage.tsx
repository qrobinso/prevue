import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash, PencilSimple } from '@phosphor-icons/react';
import { useProfile } from '../../contexts/ProfileContext';
import {
  createProfile as apiCreateProfile,
  updateProfile as apiUpdateProfile,
  deleteProfile as apiDeleteProfile,
} from '../../services/api';
import type { Profile } from '../../types';
import './ProfilePage.css';

const AVATAR_COLORS = [
  '#7c5cff', '#ff5c8a', '#22c5a8', '#f5a524',
  '#4c8dff', '#e0554f', '#8bc34a', '#b06cd8',
];

const KIDS_RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'G', 'TV-PG', 'PG'];

/** A profile's monogram rendered on its accent color. */
export function Avatar({ profile, size = 48 }: { profile: Profile; size?: number }) {
  const initial = profile.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className="profile-avatar"
      style={{
        width: size,
        height: size,
        background: profile.avatar_color,
        fontSize: Math.round(size * 0.45),
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const { profiles, activeProfile, switchProfile, refreshProfiles } = useProfile();

  const [editing, setEditing] = useState<Profile | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(AVATAR_COLORS[0]);
  const [isKids, setIsKids] = useState(false);
  const [maxRating, setMaxRating] = useState<string>(KIDS_RATINGS[1]);
  const [error, setError] = useState<string | null>(null);

  const startCreate = () => {
    setEditing(null);
    setCreating(true);
    setName('');
    setColor(AVATAR_COLORS[0]);
    setIsKids(false);
    setMaxRating(KIDS_RATINGS[1]);
    setError(null);
  };

  const startEdit = (profile: Profile) => {
    setCreating(false);
    setEditing(profile);
    setName(profile.name);
    setColor(profile.avatar_color);
    setIsKids(profile.is_kids);
    setMaxRating(profile.max_rating ?? KIDS_RATINGS[1]);
    setError(null);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
    setError(null);
  };

  const save = async () => {
    if (name.trim() === '') {
      setError('Name is required');
      return;
    }

    const payload = {
      name: name.trim(),
      avatar_color: color,
      is_kids: isKids,
      max_rating: isKids ? maxRating : null,
    };

    try {
      if (editing) await apiUpdateProfile(editing.id, payload);
      else await apiCreateProfile(payload);
      await refreshProfiles();
      closeForm();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (profile: Profile) => {
    try {
      await apiDeleteProfile(profile.id);
      await refreshProfiles();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const select = async (profile: Profile) => {
    await switchProfile(profile.id);
    navigate('/');
  };

  return (
    <div className="profile-page">
      <h1 className="profile-page-title">Who's watching?</h1>

      <div className="profile-grid">
        {profiles.map(profile => (
          <button
            key={profile.id}
            className={`profile-card ${profile.id === activeProfile?.id ? 'profile-card-active' : ''}`}
            onClick={() => void select(profile)}
          >
            <Avatar profile={profile} size={72} />
            <span className="profile-card-name">{profile.name}</span>
            {profile.is_kids && <span className="profile-card-badge">KIDS</span>}
          </button>
        ))}
      </div>

      <section className="profile-manage">
        <div className="profile-manage-header">
          <h2>Manage profiles</h2>
          <button className="profile-btn" onClick={startCreate}>
            <Plus size={16} weight="bold" /> Add profile
          </button>
        </div>

        <ul className="profile-manage-list">
          {profiles.map(profile => (
            <li key={profile.id} className="profile-manage-row">
              <Avatar profile={profile} size={32} />
              <span className="profile-manage-name">{profile.name}</span>
              {profile.is_kids && (
                <span className="profile-manage-rating">up to {profile.max_rating}</span>
              )}
              <button
                className="profile-btn"
                onClick={() => startEdit(profile)}
                aria-label={`Edit ${profile.name}`}
              >
                <PencilSimple size={16} weight="bold" />
              </button>
              <button
                className="profile-btn profile-btn-danger"
                onClick={() => void remove(profile)}
                disabled={profiles.length <= 1}
                aria-label={`Delete ${profile.name}`}
                title={profiles.length <= 1 ? 'Cannot delete the last profile' : 'Delete profile'}
              >
                <Trash size={16} weight="bold" />
              </button>
            </li>
          ))}
        </ul>

        {(creating || editing) && (
          <div className="profile-form">
            <label className="profile-form-field">
              <span>Name</span>
              <input value={name} onChange={e => setName(e.target.value)} maxLength={40} />
            </label>

            <div className="profile-form-field">
              <span>Color</span>
              <div className="profile-color-row">
                {AVATAR_COLORS.map(c => (
                  <button
                    key={c}
                    className={`profile-color ${c === color ? 'profile-color-active' : ''}`}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
            </div>

            <label className="profile-form-field profile-form-inline">
              <input type="checkbox" checked={isKids} onChange={e => setIsKids(e.target.checked)} />
              <span>Kids profile</span>
            </label>

            {isKids && (
              <label className="profile-form-field">
                <span>Maximum rating</span>
                <select value={maxRating} onChange={e => setMaxRating(e.target.value)}>
                  {KIDS_RATINGS.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
            )}

            {error && <p className="profile-form-error">{error}</p>}

            <div className="profile-form-actions">
              <button className="profile-btn" onClick={closeForm}>Cancel</button>
              <button className="profile-btn profile-btn-primary" onClick={() => void save()}>
                Save
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
