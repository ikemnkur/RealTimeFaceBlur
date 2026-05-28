/**
 * guard.js — Auth & plan access control for Face Blur
 *
 * Usage on any page:
 *   <script src="js/guard.js"></script>
 *   <script>FaceBlurAuth.requirePlan('pro');</script>   // blocks if < pro
 *   <script>FaceBlurAuth.requireAuth();</script>        // blocks if not logged in
 */

(function () {
    'use strict';

    // Auto-detect API origin: dev (localhost) vs production (DigitalOcean VPS)
    const _h = window.location.hostname;
    const API = (_h === 'localhost' || _h === '127.0.0.1' || _h.endsWith('.local'))
        ? 'http://localhost:4000'
        : 'https://server.faceblurr.com';

    /* ── Plan hierarchy ── */
    const PLAN_RANK  = { free: 0, pro: 1, advanced: 2 };
    const PLAN_LABEL = { free: 'Free', pro: 'Pro', advanced: 'Advanced' };
    const PLAN_PRICE = { free: '$0', pro: '$2.99', advanced: '$4.99' };

    /* ── Token helpers ── */
    function decodeJWT(token) {
        try {
            const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const pad = b64.length % 4 ? b64 + '='.repeat(4 - b64.length % 4) : b64;
            return JSON.parse(atob(pad));
        } catch { return null; }
    }

    function getAuth() {
        const token = localStorage.getItem('fb_token');
        if (!token) return null;

        const payload = decodeJWT(token);
        if (!payload) return null;

        /* Expired token */
        if (payload.exp && Date.now() / 1000 > payload.exp) {
            localStorage.removeItem('fb_token');
            localStorage.removeItem('fb_user');
            return null;
        }

        /* accountType may be missing from older tokens — fall back to stored user */
        if (!payload.accountType) {
            try {
                const stored = JSON.parse(localStorage.getItem('fb_user') || '{}');
                payload.accountType = stored.accountType || 'free';
            } catch { payload.accountType = 'free'; }
        }

        return payload;
    }

    /* ── Paywall overlay ── */
    function showPaywall(required, current) {
        /* Prevent duplicate overlays */
        if (document.getElementById('fb-paywall')) return;

        const overlay = document.createElement('div');
        overlay.id = 'fb-paywall';
        overlay.innerHTML = `
<style>
#fb-paywall {
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
    background: rgba(13,13,18,0.92);
    backdrop-filter: blur(12px);
    padding: 1.5rem;
    font-family: 'DM Mono', monospace;
}
#fb-paywall-card {
    background: #14141c;
    border: 1px solid rgba(124,108,252,0.35);
    border-radius: 20px;
    padding: 2.5rem 2rem;
    max-width: 460px;
    width: 100%;
    text-align: center;
    box-shadow: 0 32px 96px rgba(0,0,0,0.7);
    animation: fb-slide-up 0.25s ease;
}
@keyframes fb-slide-up {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
}
#fb-paywall-card .fb-pw-icon { font-size: 2.5rem; margin-bottom: 0.9rem; }
#fb-paywall-card h2 {
    font-family: 'Syne', sans-serif;
    font-size: 1.25rem; font-weight: 800;
    letter-spacing: -0.03em; color: #e2e8f0;
    margin-bottom: 0.5rem;
}
#fb-paywall-card .fb-pw-sub {
    font-size: 0.78rem; color: #64748b;
    line-height: 1.75; margin-bottom: 1.75rem;
}
#fb-paywall-card .fb-pw-sub strong { color: #7c6cfc; }
#fb-paywall-card .fb-pw-current {
    display: inline-block;
    font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase;
    color: #64748b; border: 1px solid rgba(255,255,255,0.08);
    background: #1c1c28; border-radius: 999px;
    padding: 0.25rem 0.8rem; margin-bottom: 1.5rem;
}
#fb-paywall-card .fb-pw-btns {
    display: flex; gap: 0.75rem;
    justify-content: center; flex-wrap: wrap;
}
.fb-pw-btn-primary, .fb-pw-btn-secondary {
    display: inline-block;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem; letter-spacing: 0.07em; text-transform: uppercase;
    padding: 0.65rem 1.4rem; border-radius: 8px;
    text-decoration: none; cursor: pointer;
    transition: background 0.18s, border-color 0.18s, color 0.18s;
    border: 1px solid transparent;
}
.fb-pw-btn-primary {
    background: #7c6cfc; color: #fff;
    border-color: #7c6cfc;
}
.fb-pw-btn-primary:hover { background: #c084fc; border-color: #c084fc; }
.fb-pw-btn-secondary {
    background: transparent; color: #e2e8f0;
    border-color: rgba(255,255,255,0.08);
}
.fb-pw-btn-secondary:hover { border-color: #7c6cfc; color: #7c6cfc; }
</style>

<div id="fb-paywall-card">
    <div class="fb-pw-icon">🔒</div>
    <h2>${PLAN_LABEL[required] || required} Plan Required</h2>
    <p class="fb-pw-sub">
        This feature requires a <strong>${PLAN_LABEL[required]}</strong> subscription (${PLAN_PRICE[required]}/mo).<br>
        You are currently on the <strong style="color:#e2e8f0">${PLAN_LABEL[current] || current}</strong> plan.
    </p>
    <div class="fb-pw-current">Current plan: ${PLAN_LABEL[current] || current}</div>
    <div class="fb-pw-btns">
        <a href="checkout.html?plan=${required}&return=${encodeURIComponent(location.href)}" class="fb-pw-btn-primary">
            ✦ Upgrade to ${PLAN_LABEL[required]}
        </a>
        <a href="javascript:history.back()" class="fb-pw-btn-secondary">← Go Back</a>
    </div>
</div>`;

        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
    }

    /* ── Login wall ── */
    function showLoginWall() {
        if (document.getElementById('fb-paywall')) return;

        const overlay = document.createElement('div');
        overlay.id = 'fb-paywall';
        overlay.innerHTML = `
<style>
/* reuse styles defined above if already injected */
#fb-paywall {
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
    background: rgba(13,13,18,0.92); backdrop-filter: blur(12px); padding: 1.5rem;
    font-family: 'DM Mono', monospace;
}
#fb-paywall-card {
    background: #14141c; border: 1px solid rgba(124,108,252,0.35);
    border-radius: 20px; padding: 2.5rem 2rem; max-width: 420px; width: 100%;
    text-align: center; box-shadow: 0 32px 96px rgba(0,0,0,0.7);
    animation: fb-slide-up 0.25s ease;
}
@keyframes fb-slide-up { from { opacity:0;transform:translateY(20px) } to { opacity:1;transform:none } }
#fb-paywall-card h2 { font-family:'Syne',sans-serif; font-size:1.25rem; font-weight:800; color:#e2e8f0; margin: 0.75rem 0 0.5rem; }
#fb-paywall-card p  { font-size:0.78rem; color:#64748b; line-height:1.75; margin-bottom:1.75rem; }
.fb-pw-btn-primary,.fb-pw-btn-secondary { display:inline-block; font-family:'DM Mono',monospace; font-size:0.75rem; letter-spacing:0.07em; text-transform:uppercase; padding:0.65rem 1.4rem; border-radius:8px; text-decoration:none; transition:background 0.18s,border-color 0.18s,color 0.18s; border:1px solid transparent; }
.fb-pw-btn-primary { background:#7c6cfc; color:#fff; border-color:#7c6cfc; }
.fb-pw-btn-primary:hover { background:#c084fc; border-color:#c084fc; }
.fb-pw-btn-secondary { background:transparent; color:#e2e8f0; border-color:rgba(255,255,255,0.08); }
.fb-pw-btn-secondary:hover { border-color:#7c6cfc; color:#7c6cfc; }
.fb-pw-btns { display:flex; gap:0.75rem; justify-content:center; flex-wrap:wrap; }
</style>

<div id="fb-paywall-card">
    <div style="font-size:2.5rem;margin-bottom:0.75rem">🔐</div>
    <h2>Sign In Required</h2>
    <p>You need to be signed in to access this feature.<br>Create a free account to get started.</p>
    <div class="fb-pw-btns">
        <a href="/login?return=${encodeURIComponent(location.href)}" class="fb-pw-btn-primary">Sign In</a>
        <a href="/register?return=${encodeURIComponent(location.href)}" class="fb-pw-btn-secondary">Create Account</a>
    </div>
</div>`;

        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
    }

    /* ── Token refresh via API ── */
    async function refreshToken() {
        const token = localStorage.getItem('fb_token');
        if (!token) return null;
        try {
            const res = await fetch(`${API}/api/auth/refresh-token`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (data.success && data.token) {
                localStorage.setItem('fb_token', data.token);
                if (data.user) {
                    const stored = JSON.parse(localStorage.getItem('fb_user') || '{}');
                    localStorage.setItem('fb_user', JSON.stringify({ ...stored, ...data.user }));
                }
                return data;
            }
            return null;
        } catch { return null; }
    }

    /* ── Public API ── */
    window.FaceBlurAuth = {
        API,
        PLAN_RANK,
        PLAN_LABEL,

        /** Returns decoded JWT payload or null if not logged in / expired */
        getAuth,

        /** Redirects to login if not authenticated */
        requireAuth() {
            const auth = getAuth();
            if (!auth) { showLoginWall(); return false; }
            return true;
        },

        /**
         * Blocks page access if user's plan is below minPlan.
         * @param {'pro'|'advanced'} minPlan
         */
        requirePlan(minPlan) {
            const auth = getAuth();
            if (!auth) { showLoginWall(); return false; }

            const userRank     = PLAN_RANK[auth.accountType] ?? 0;
            const requiredRank = PLAN_RANK[minPlan] ?? 0;

            if (userRank < requiredRank) {
                showPaywall(minPlan, auth.accountType);
                return false;
            }
            return true;
        },

        /** Fetches a fresh JWT from the server (call after Stripe payment) */
        refreshToken,

        logout() {
            localStorage.removeItem('fb_token');
            localStorage.removeItem('fb_user');
            location.href = '/login';
        },

        /** Injects user menu pill into nav when logged in, keeps Sign In when logged out */
        updateNav() {
            const auth = getAuth();

            /* Inject dropdown styles once */
            if (!document.getElementById('fb-nav-styles')) {
                const s = document.createElement('style');
                s.id = 'fb-nav-styles';
                s.textContent = `
.fb-user-menu { position: relative; display: inline-flex; align-items: center; }
.fb-user-pill {
    display: inline-flex; align-items: center; gap: 0.45rem;
    background: rgba(124,108,252,0.12); border: 1px solid rgba(124,108,252,0.35);
    color: var(--text,#e2e8f0); border-radius: 999px;
    padding: 0.25rem 0.75rem 0.25rem 0.35rem;
    font-family: var(--mono,'DM Mono',monospace); font-size: 0.75rem;
    letter-spacing: 0.04em; cursor: pointer; transition: border-color 0.2s, background 0.2s;
    user-select: none;
}
.fb-user-pill:hover { border-color: var(--accent,#7c6cfc); background: rgba(124,108,252,0.2); }
.fb-avatar {
    width: 1.5rem; height: 1.5rem; border-radius: 50%;
    background: linear-gradient(135deg,var(--accent,#7c6cfc),var(--accent2,#c084fc));
    color: #fff; font-size: 0.65rem; font-weight: 700;
    display: flex; align-items: center; justify-content: center; text-transform: uppercase; flex-shrink: 0;
}
.fb-plan-badge {
    font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase;
    padding: 0.1rem 0.45rem; border-radius: 999px; font-weight: 600;
}
.fb-plan-badge.free     { background:rgba(100,116,139,0.2); color:#64748b; }
.fb-plan-badge.pro      { background:rgba(124,108,252,0.2); color:#7c6cfc; }
.fb-plan-badge.advanced { background:rgba(192,132,252,0.2); color:#c084fc; }
.fb-dropdown {
    display: none; position: absolute; top: calc(100% + 0.5rem); right: 0;
    min-width: 180px; background: var(--surface,#14141c);
    border: 1px solid var(--border,rgba(255,255,255,0.07));
    border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,0.6);
    padding: 0.4rem; z-index: 9999; animation: fb-dd-in 0.15s ease;
}
@keyframes fb-dd-in { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:none} }
.fb-dropdown.open { display: block; }
.fb-dd-item {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.55rem 0.75rem; border-radius: 8px;
    font-family: var(--mono,'DM Mono',monospace); font-size: 0.75rem;
    letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--muted,#64748b); text-decoration: none; cursor: pointer;
    transition: background 0.15s, color 0.15s; white-space: nowrap;
}
.fb-dd-item:hover { background: var(--surface2,#1c1c28); color: var(--text,#e2e8f0); }
.fb-dd-item.danger:hover { background: rgba(248,113,113,0.08); color: var(--red,#f87171); }
.fb-dd-sep { height: 1px; background: var(--border,rgba(255,255,255,0.07)); margin: 0.3rem 0; }
`;
                document.head.appendChild(s);
            }

            /* Find the Sign In anchor */
            const signinEl = document.querySelector('a[href="/login"].nav-cta, a[href="/login"], a[href="login.html"]');
            if (!signinEl) return;
            const li = signinEl.closest('li') || signinEl.parentElement;

            if (!auth) {
                /* Not logged in — make sure Sign In link is intact */
                signinEl.textContent = 'Sign In';
                signinEl.href = '/login';
                signinEl.className = 'nav-cta';
                return;
            }

            /* ── Build user pill + dropdown ── */
            // const username = auth.username || auth.email?.split('@')[0] || 'Account';
            const username = auth.username || 'Account';
            const plan     = auth.accountType || 'free';
            const initial  = username.charAt(0).toUpperCase();

            const wrapper = document.createElement('div');
            wrapper.className = 'fb-user-menu';
            wrapper.innerHTML = `
<div class="fb-user-pill" id="fb-pill">
    <span class="fb-avatar">${initial}</span>
    <span>${username}</span>
    <span class="fb-plan-badge ${plan}">${plan}</span>
</div>
<div class="fb-dropdown" id="fb-dd">
    <a href="/dashboard" class="fb-dd-item">⊞ Dashboard</a>
    <a href="/plans" class="fb-dd-item">◈ Plans</a>
    <div class="fb-dd-sep"></div>
    <div class="fb-dd-item danger" id="fb-logout-btn">⏻ Sign Out</div>
</div>`;

            /* Replace the <li> contents */
            if (li && li.tagName === 'LI') {
                li.innerHTML = '';
                li.appendChild(wrapper);
            } else {
                signinEl.replaceWith(wrapper);
            }

            /* Toggle dropdown */
            const pill = wrapper.querySelector('#fb-pill');
            const dd   = wrapper.querySelector('#fb-dd');
            pill.addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('open'); });
            document.addEventListener('click', () => dd.classList.remove('open'));

            /* Logout */
            wrapper.querySelector('#fb-logout-btn').addEventListener('click', () => {
                localStorage.removeItem('fb_token');
                localStorage.removeItem('fb_user');
                location.href = '/login';
            });
        }
    };

    /* Auto-update nav on every page that loads guard.js */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.FaceBlurAuth.updateNav());
    } else {
        window.FaceBlurAuth.updateNav();
    }

})();
