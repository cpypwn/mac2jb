(function () {
  const marker = '__MAC2JB_CIV_HELLO_NONCE__';
  const body = document.body;
  if (!body) throw new Error('CivSwitch display is unavailable');

  const oldStyle = document.getElementById('mac2jb-civ-hello-style');
  if (oldStyle) oldStyle.remove();
  const oldDisplay = document.getElementById('mac2jb-civ-hello');
  if (oldDisplay) oldDisplay.remove();

  const style = document.createElement('style');
  style.id = 'mac2jb-civ-hello-style';
  style.textContent = `
    @keyframes civ-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes civ-breathe { 0%, 100% { opacity: .52; transform: scale(.92); } 50% { opacity: .9; transform: scale(1.08); } }
    @keyframes civ-glow { 0%, 100% { box-shadow: 0 0 32px rgba(129,255,191,.14), inset 0 0 32px rgba(129,255,191,.08); } 50% { box-shadow: 0 0 65px rgba(129,255,191,.3), inset 0 0 55px rgba(129,255,191,.14); } }
    @keyframes civ-twinkle { 0%, 100% { opacity: .18; transform: scale(.65); } 50% { opacity: .9; transform: scale(1.35); } }
    #mac2jb-civ-hello { position: fixed; z-index: 2147483647; inset: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; background: radial-gradient(ellipse at 50% 52%, #174236 0%, #092923 35%, #041713 72%, #020b0a 100%); color: #effff6; font-family: Arial, Helvetica, sans-serif; pointer-events: none; }
    #mac2jb-civ-hello .aura { position: absolute; width: 72vmin; height: 72vmin; max-width: 720px; max-height: 720px; border-radius: 50%; background: radial-gradient(circle, rgba(90,255,180,.33), rgba(43,187,148,.13) 38%, transparent 68%); filter: blur(18px); animation: civ-breathe 5s ease-in-out infinite; }
    #mac2jb-civ-hello .ring { position: absolute; width: 62vmin; height: 62vmin; max-width: 620px; max-height: 620px; border-radius: 50%; border: 2px solid rgba(140,255,204,.24); box-shadow: 0 0 30px rgba(116,255,185,.12), inset 0 0 30px rgba(116,255,185,.08); animation: civ-rotate 24s linear infinite; }
    #mac2jb-civ-hello .ring.two { width: 48vmin; height: 48vmin; max-width: 480px; max-height: 480px; border-style: dashed; border-color: rgba(154,255,218,.3); animation-duration: 31s; animation-direction: reverse; }
    #mac2jb-civ-hello .ring.three { width: 78vmin; height: 78vmin; max-width: 780px; max-height: 780px; border-color: rgba(91,205,174,.14); animation-duration: 42s; }
    #mac2jb-civ-hello .spark { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: #adffd0; box-shadow: 0 0 14px #87ffc1; animation: civ-twinkle 3s ease-in-out infinite; }
    #mac2jb-civ-hello .card { position: relative; z-index: 2; margin: 30px; padding: 30px 46px; border: 1px solid rgba(153,255,209,.55); border-radius: 26px; background: rgba(5,24,22,.78); animation: civ-glow 4s ease-in-out infinite; }
    #mac2jb-civ-hello .message { font-size: clamp(30px, 6vw, 78px); font-weight: 700; letter-spacing: .02em; line-height: 1.12; text-align: center; color: #f3fff8; text-shadow: 0 0 22px rgba(128,255,192,.7), 0 0 54px rgba(94,220,161,.33); }
  `;
  body.appendChild(style);

  const root = document.createElement('div');
  root.id = 'mac2jb-civ-hello';
  const aura = document.createElement('div');
  aura.className = 'aura';
  root.appendChild(aura);
  for (const className of ['ring', 'ring two', 'ring three']) {
    const ring = document.createElement('div');
    ring.className = className;
    root.appendChild(ring);
  }
  for (let i = 0; i < 24; i++) {
    const spark = document.createElement('div');
    const angle = i * Math.PI * 2 / 24;
    const radius = 28 + (i % 4) * 5;
    spark.className = 'spark';
    spark.style.left = (50 + Math.cos(angle) * radius) + '%';
    spark.style.top = (50 + Math.sin(angle) * radius) + '%';
    spark.style.animationDelay = (i % 7) * -.44 + 's';
    root.appendChild(spark);
  }
  const card = document.createElement('div');
  card.className = 'card';
  const message = document.createElement('div');
  message.className = 'message';
  message.textContent = 'hellow from cpypwn!';
  card.appendChild(message);
  root.appendChild(card);
  body.appendChild(root);
  return log(marker);
})()
