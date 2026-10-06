import { modules } from './module-config';
export type NavItem = { label: string; slug: string; short?: string };
export type NavGroup = { label: string; items: NavItem[] };
export const navigation: NavGroup[] = [
  { label: 'Workforce planning', items: [
    { label: 'Overview', slug: 'overview' },
    { label: 'People needing a role', slug: 'redeployment' },
    { label: 'Teams needing people', slug: 'demand' },
    { label: 'Find matches', slug: 'matches' },
    { label: 'Transfers', slug: 'mobility' },
  ] },
  { label: 'Supporting data', items: [
    { label: 'People & skills', slug: 'workforce' },
    { label: 'Import data', slug: 'hr-import-center' },
    { label: 'Administration', slug: 'admin' },
  ] },
];
// Existing bookmarks remain resolvable; legacy modules are outside the main navigation.
export const navItemFor = (slug: string): NavItem | undefined =>
  navigation.flatMap(group => group.items).find(item => item.slug === slug) ??
  (modules[slug] ? { slug, label: modules[slug].title } : undefined);
