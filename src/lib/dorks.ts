export interface DorkOperator {
  operator: string;
  description: string;
  example: string;
}

export interface DorkTemplate {
  label: string;
  group: string;
  /** `{target}` is replaced with the current query (or left as a placeholder to fill in). */
  pattern: string;
  note?: string;
}

/** Google-style operators. DuckDuckGo and Brave honour most of these; GitHub, arXiv, OpenAlex and Wikipedia ignore them. */
export const DORK_OPERATORS: DorkOperator[] = [
  { operator: 'site:', description: 'Limit to one domain or subdomain', example: 'site:example.com' },
  { operator: 'inurl:', description: 'Match text inside the URL', example: 'inurl:admin' },
  { operator: 'intitle:', description: 'Match text in the page title', example: 'intitle:"index of"' },
  { operator: 'allintitle:', description: 'All terms must appear in the title', example: 'allintitle:index of backup' },
  { operator: 'intext:', description: 'Match text in the page body', example: 'intext:"api_key"' },
  { operator: 'filetype:', description: 'Restrict to a file extension', example: 'filetype:pdf' },
  { operator: 'ext:', description: 'Alias for filetype', example: 'ext:sql' },
  { operator: 'related:', description: 'Sites similar to a URL', example: 'related:example.com' },
  { operator: 'link:', description: 'Pages linking to a URL (deprecated by Google, still indexed elsewhere)', example: 'link:example.com' },
  { operator: 'cache:', description: 'Cached copy of a page (deprecated by Google)', example: 'cache:example.com' },
  { operator: 'before:', description: 'Results published before a date', example: 'before:2024-01-01' },
  { operator: 'after:', description: 'Results published after a date', example: 'after:2025-01-01' },
  { operator: '" "', description: 'Exact phrase match', example: '"password reset"' },
  { operator: 'OR / |', description: 'Either term', example: 'ext:env OR ext:ini' },
  { operator: '-', description: 'Exclude a term', example: '-site:example.com' },
  { operator: '*', description: 'Wildcard inside a phrase', example: '"index of * backup"' },
];

/**
 * Templates follow the GHDB categories plus the red-team / OSINT playbooks:
 * exposed files, open directories, secrets, code & paste leaks, infra fingerprints, people, research.
 */
export const DORK_TEMPLATES: DorkTemplate[] = [
  // Exposed files
  { group: 'Exposed files', label: 'PDFs on the target', pattern: 'site:{target} filetype:pdf' },
  { group: 'Exposed files', label: 'Spreadsheets and CSVs', pattern: 'site:{target} (filetype:xls OR filetype:xlsx OR filetype:csv)' },
  { group: 'Exposed files', label: 'Documents and archives', pattern: 'site:{target} (filetype:doc OR filetype:docx OR filetype:zip OR filetype:rar)' },
  { group: 'Exposed files', label: 'Log files', pattern: 'site:{target} ext:log' },
  { group: 'Exposed files', label: 'Open directory listings', pattern: 'site:{target} intitle:"index of"' },
  { group: 'Exposed files', label: 'Backup directories', pattern: 'site:{target} intitle:"index of" backup' },

  // Secrets & credentials
  { group: 'Secrets & credentials', label: 'Env / config files', pattern: 'site:{target} (ext:env OR ext:ini OR ext:yml OR ext:yaml OR ext:conf)' },
  { group: 'Secrets & credentials', label: 'Key material', pattern: 'site:{target} (ext:pem OR ext:key OR ext:p12 OR ext:pfx)' },
  { group: 'Secrets & credentials', label: 'Private key blocks', pattern: 'site:{target} intext:"BEGIN RSA PRIVATE KEY"' },
  { group: 'Secrets & credentials', label: 'Password mentions', pattern: 'site:{target} (ext:txt OR ext:cfg OR ext:xml) intext:password' },
  { group: 'Secrets & credentials', label: 'CMS config files', pattern: 'site:{target} (inurl:wp-config.php OR inurl:config.php OR inurl:database.yml)' },
  { group: 'Secrets & credentials', label: 'Exposed .git or .env', pattern: 'site:{target} (inurl:.git/config OR inurl:.env OR inurl:.svn)' },
  { group: 'Secrets & credentials', label: 'phpMyAdmin panels', pattern: 'site:{target} inurl:phpmyadmin' },
  { group: 'Secrets & credentials', label: 'Admin and login pages', pattern: 'site:{target} (inurl:admin OR inurl:login OR inurl:dashboard)' },

  // Databases & backups
  { group: 'Databases & backups', label: 'SQL dumps', pattern: 'site:{target} (ext:sql OR ext:dump OR ext:sqlite OR ext:db)' },
  { group: 'Databases & backups', label: 'Archive backups', pattern: 'site:{target} (ext:bak OR ext:backup OR ext:old OR ext:tar OR ext:gz)' },
  { group: 'Databases & backups', label: 'Exposed buckets', pattern: 'site:s3.amazonaws.com "{target}"', note: 'Swap in the bucket name for the target when you have it.' },

  // Infra & fingerprints
  { group: 'Infra & fingerprints', label: 'Jenkins dashboards', pattern: 'site:{target} intitle:"Dashboard [Jenkins]"' },
  { group: 'Infra & fingerprints', label: 'Grafana / Kibana', pattern: 'site:{target} (intitle:Grafana OR intitle:Kibana)' },
  { group: 'Infra & fingerprints', label: 'Alternate ports in URLs', pattern: 'site:{target} (inurl::8080 OR inurl::8443 OR inurl::9000)' },
  { group: 'Infra & fingerprints', label: 'Server status pages', pattern: 'site:{target} (inurl:server-status OR inurl:server-info)' },
  { group: 'Infra & fingerprints', label: 'Exposed APIs and swagger', pattern: 'site:{target} (inurl:swagger OR inurl:api-docs OR inurl:graphql)' },
  { group: 'Infra & fingerprints', label: 'Webcams and IoT panels', pattern: 'site:{target} (inurl:view.shtml OR intitle:"Network Camera" OR intitle:"Live View")' },

  // Code & leaks
  { group: 'Code & leaks', label: 'GitHub references', pattern: '{target} site:github.com' },
  { group: 'Code & leaks', label: 'Secrets committed on GitHub', pattern: '{target} site:github.com (password OR api_key OR secret OR token)', note: 'GitHub code search needs a token; repo search works without one.' },
  { group: 'Code & leaks', label: 'GitLab projects', pattern: '{target} site:gitlab.com' },
  { group: 'Code & leaks', label: 'Pastebin mentions', pattern: '{target} site:pastebin.com' },
  { group: 'Code & leaks', label: 'Public boards and docs', pattern: '{target} (site:trello.com OR site:notion.site OR site:docs.google.com)' },

  // People & identity
  { group: 'People & identity', label: 'LinkedIn profiles', pattern: '"{target}" site:linkedin.com' },
  { group: 'People & identity', label: 'Social mentions', pattern: '"{target}" (site:x.com OR site:reddit.com OR site:news.ycombinator.com)' },
  { group: 'People & identity', label: 'Resumes and CVs', pattern: '"{target}" (filetype:pdf OR filetype:doc) resume' },
  { group: 'People & identity', label: 'Email format hints', pattern: '"{target}" ("@" OR email) filetype:pdf' },

  // Geo & research
  { group: 'Geo & research', label: 'Maps and coordinates', pattern: '"{target}" (site:maps.google.com OR site:openstreetmap.org)' },
  { group: 'Geo & research', label: 'Academic PDFs', pattern: '{target} filetype:pdf study' },
  { group: 'Geo & research', label: 'Government sources', pattern: '{target} site:gov' },
  { group: 'Geo & research', label: 'Before a date', pattern: '{target} before:2024-01-01' },
];

/** Lanes are the dork template groups: one lane is one playbook worth running end to end. */
export const DORK_LANES: string[] = [...new Set(DORK_TEMPLATES.map((template) => template.group))];

/** Expand a whole lane against a target, ready to run as a batch of queries. */
export function expandLane(group: string, target: string, limit = 10): string[] {
  const clean = target.trim();
  if (!clean) return [];
  return DORK_TEMPLATES.filter((template) => template.group === group)
    .map((template) => template.pattern.replace(/\{target\}/g, clean))
    .slice(0, limit);
}

export const DORK_ENGINE_NOTE =
  'Operators apply on DuckDuckGo and Brave. GitHub, arXiv, OpenAlex and Wikipedia ignore dork syntax; the browser engines (Hacker News, Stack Overflow, Crossref) treat the query as plain text.';
