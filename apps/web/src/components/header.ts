/**
 * Top-Nav-Header — Logo + Routes + Sign-out.
 *
 * Wird von allen authenticated-Views (approval, credentials, enroll)
 * gerendert. Hash-basierte Navigation — `main.ts` reagiert auf `hashchange`.
 */
import type { Session } from '../api.js';

interface NavItem {
  readonly href: string;
  readonly label: string;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: '#/approvals', label: 'Approvals' },
  { href: '#/credentials', label: 'Credentials' },
];

export function renderHeader(root: HTMLElement, session: Session, onLogout: () => void): void {
  const header = document.createElement('header');
  header.className = 'topbar';

  const brand = document.createElement('div');
  brand.className = 'topbar-brand';
  const brandLink = document.createElement('a');
  brandLink.href = '#/approvals';
  brandLink.textContent = 'mcp-approval2';
  brand.appendChild(brandLink);
  header.appendChild(brand);

  const nav = document.createElement('nav');
  nav.className = 'topbar-nav';
  const currentHash = window.location.hash || '#/approvals';
  for (const item of NAV_ITEMS) {
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    if (currentHash.startsWith(item.href)) {
      a.className = 'active';
    }
    nav.appendChild(a);
  }
  header.appendChild(nav);

  const userBox = document.createElement('div');
  userBox.className = 'topbar-user';

  if (session.email) {
    const email = document.createElement('span');
    email.className = 'muted small';
    email.textContent = session.email;
    userBox.appendChild(email);
  }

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'btn btn-secondary btn-small';
  logoutBtn.textContent = 'Sign out';
  logoutBtn.addEventListener('click', onLogout);
  userBox.appendChild(logoutBtn);

  header.appendChild(userBox);
  root.appendChild(header);
}
