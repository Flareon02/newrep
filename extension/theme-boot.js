// Apply the saved colour scheme before the stylesheets paint (no flash): 'dark' (default), 'light' or 'system'.
// app.js keeps the mirror in localStorage in sync with prefs.theme.
try {
 const saved=localStorage.getItem('monitor-theme')||'dark';
 document.documentElement.dataset.theme=saved==='system'
  ?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')
  :(['dark','light'].includes(saved)?saved:'dark');
}catch{document.documentElement.dataset.theme='dark';}
