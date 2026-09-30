// Apply the last selected color scheme before the stylesheets can paint.
try {
 const saved=localStorage.getItem('monitor-theme')||'system';
 document.documentElement.dataset.theme=saved==='system'
  ?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')
  :(['dark','light'].includes(saved)?saved:'dark');
}catch{document.documentElement.dataset.theme='dark';}
