import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { SliderToggle } from '../SliderToggle';
import { useAppStore } from '../../services/store';
import { supabase } from '../../services/supabase';
import { fetchUserPreferences, upsertUserPreferences } from '../../services/api';
import { fetchProfile, forgetEverything, forgetProfileItem, type ProfileVersion } from '../../services/tutor';

// Settings › ハルカ (design-system §6.17): which edge opens her, how she corrects,
// and "what ハルカ knows" — the learner profile in plain language, last night's
// changes, and delete on any line (a trust feature, docs/learner-memory-design.md §2).

const sectionTitle: React.CSSProperties = { fontFamily: 'var(--font-serif)', fontSize: '1.3rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '1.2rem' };
const labelStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '0.6rem' };
const hintStyle: React.CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.45rem', lineHeight: 1.5 };
const settingStyle: React.CSSProperties = { marginBottom: '1.6rem' };

const HAND_OPTIONS = [
  { value: 'right', label: 'Right edge' },
  { value: 'left', label: 'Left edge' },
] as const;
const CORRECTION_OPTIONS = [
  { value: 'recast', label: 'Gently' },
  { value: 'all', label: 'Everything' },
  { value: 'ask', label: 'When I ask' },
] as const;
const CORRECTION_HINT: Record<string, string> = {
  recast: 'Slips are said back correctly; repeated mistakes get a short note.',
  all: 'Every mistake is corrected.',
  ask: 'Only when you ask.',
};
const ASIDE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'ja', label: <span lang="ja" translate="no">やさしい日本語</span> },
] as const;

const KIND_LABEL: Record<string, string> = {
  interest: 'Interests', personal: 'About you', struggle: 'Finding hard', grammar: 'Grammar',
  word: 'Words', preference: 'Preferences', level: 'Level',
};

export function TutorSettings() {
  const hand = useAppStore((s) => s.tutorHand);
  const setTutorHand = useAppStore((s) => s.setTutorHand);
  const [prefs, setPrefs] = useState<{ correction?: string; asides?: string }>({});
  const [profile, setProfile] = useState<ProfileVersion | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { setLoaded(true); return; }
      const [p, v] = await Promise.all([fetchUserPreferences(session.user.id), fetchProfile()]);
      if (!live) return;
      setPrefs(p?.tutor_prefs ?? {});
      setProfile(v);
      setLoaded(true);
    })().catch(() => setLoaded(true));
    return () => { live = false; };
  }, []);

  const savePrefs = async (next: { correction?: string; asides?: string }) => {
    setPrefs(next);
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) upsertUserPreferences(session.user.id, { tutor_prefs: next });
  };

  const forget = async (id: string) => {
    if (!profile) return;
    const next = await forgetProfileItem(profile, id);
    if (next) setProfile(next);
  };

  const groups = new Map<string, ProfileVersion['profile']['items']>();
  for (const item of profile?.profile.items ?? []) {
    const g = groups.get(item.kind) ?? [];
    g.push(item);
    groups.set(item.kind, g);
  }
  const changes = profile?.changes;
  const changed = changes && (changes.added.length + changes.faded.length + changes.updated.length) > 0;

  return (
    <section style={{ marginBottom: '3rem' }}>
      <h3 lang="ja" style={sectionTitle}>ハルカ</h3>
      <div style={settingStyle}>
        <div style={labelStyle}>Swipe in from</div>
        <SliderToggle options={HAND_OPTIONS} value={hand} onChange={setTutorHand} ariaLabel="Edge that opens ハルカ" />
        <div style={hintStyle}>In the installed app. In a browser tab, drag up on the tab bar.</div>
      </div>
      <div style={settingStyle}>
        <div style={labelStyle}>Corrections</div>
        <SliderToggle options={CORRECTION_OPTIONS} value={prefs.correction ?? 'recast'} onChange={(v) => savePrefs({ ...prefs, correction: v })} fontSize="0.8rem" ariaLabel="Corrections" />
        <div style={hintStyle}>{CORRECTION_HINT[prefs.correction ?? 'recast']} You can also just tell her.</div>
      </div>
      <div style={settingStyle}>
        <div style={labelStyle}>Explains in</div>
        <SliderToggle options={ASIDE_OPTIONS} value={prefs.asides ?? 'en'} onChange={(v) => savePrefs({ ...prefs, asides: v })} ariaLabel="Explanation language" />
      </div>

      <details>
        <summary style={{ ...labelStyle, cursor: 'pointer', listStyle: 'none', marginBottom: 0 }}>
          <span>What ハルカ knows</span>
          <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>
            {profile ? `${profile.profile.items.length} things` : loaded ? 'nothing yet' : ''}
          </span>
        </summary>
        <div style={{ marginTop: '0.9rem' }}>
          {!profile && loaded && (
            <p style={hintStyle}>She writes this each night from what you read, hear and tell her. Check back tomorrow.</p>
          )}
          {profile && <>
            <p className="serif" style={{ fontSize: '1rem', lineHeight: 1.7, color: 'var(--text-main)' }}>{profile.profile.summary}</p>
            {changed && (
              <p style={{ ...hintStyle, marginTop: '0.6rem' }}>
                Last night: {[
                  changes!.added.length ? `new — ${changes!.added.join(', ')}` : '',
                  changes!.updated.length ? `updated — ${changes!.updated.join(', ')}` : '',
                  changes!.faded.length ? `faded — ${changes!.faded.join(', ')}` : '',
                ].filter(Boolean).join(' · ')}
              </p>
            )}
            {[...groups.entries()].map(([kind, items]) => (
              <div key={kind} style={{ marginTop: '1.1rem' }}>
                <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.14em', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>
                  {(KIND_LABEL[kind] ?? kind).toUpperCase()}
                </div>
                {items.map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', padding: '0.45rem 0', borderTop: '1px solid var(--border-light)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.88rem', color: 'var(--text-main)', lineHeight: 1.45 }}>{item.text}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{item.evidence}</div>
                    </div>
                    <button onClick={() => forget(item.id)} aria-label={`Forget: ${item.text}`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.15rem', display: 'flex' }}>
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </>}
          <div style={{ marginTop: '1.4rem' }}>
            {confirmAll ? (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Forget everything, including conversations?{' '}
                <button onClick={async () => { await forgetEverything(); setProfile(null); setConfirmAll(false); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-main)' }}>Forget</button>
                <button onClick={() => setConfirmAll(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Keep</button>
              </span>
            ) : (
              <button onClick={() => setConfirmAll(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-muted)', padding: 0 }}>
                Forget everything
              </button>
            )}
          </div>
          <p style={hintStyle}>Conversations are kept word for word for 30 days; the summaries stay until you delete them.</p>
        </div>
      </details>
    </section>
  );
}
