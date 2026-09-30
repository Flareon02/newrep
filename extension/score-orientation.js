/* Score display orientation only. Matching belongs to the server. */
(function(root){
 function pair(value){return Array.isArray(value)&&value.length>=2?[value[1],value[0]]:value;}
 function orient(ref){
  if(ref?.scoreReversed!==true)return {...ref};
  return {...ref,seriesScore:pair(ref.seriesScore),mapScores:Array.isArray(ref.mapScores)?ref.mapScores.map(pair):ref.mapScores,scoreText:String(ref.scoreText||'').replace(/(\d+)\s*:\s*(\d+)/g,(_,a,b)=>`${b}:${a}`)};
 }
 const api={orient};if(typeof module==='object'&&module.exports)module.exports=api;else root.ScoreOrientation=api;
})(globalThis);
