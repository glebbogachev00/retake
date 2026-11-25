/* Larkspur: a made-up room-booking app for Watch mode's examples.
   Every route renders from the data below; a saved booking lives in
   localStorage, so the app needs no server beyond a static one. */
(() => {
  'use strict';
  const LOGO = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="7" fill="#5a47d1"/><circle cx="12" cy="6.6" r="2.3" fill="#fff"/><circle cx="9.2" cy="11" r="2.3" fill="#fff" opacity=".85"/><circle cx="14.8" cy="11" r="2.3" fill="#fff" opacity=".85"/><circle cx="12" cy="15.4" r="2.3" fill="#fff" opacity=".7"/><rect x="11.3" y="16" width="1.4" height="4.4" rx=".7" fill="#fff" opacity=".7"/></svg>';
  const PEOPLE = { MO: '#c0587e', SK: '#2f8a6b', JR: '#d08a2c', AL: '#4f7fd1', PN: '#8a5bd1', TB: '#3a9aa8', EV: '#b9603d' };
  const ROOMS = [
    { id: 'juniper', name: 'Juniper', color: '#3f9168', floor: 3, wing: 'East wing', seats: 8, kit: ['Screen', 'Whiteboard', 'Video call'], status: ['free', 'Free until 16:00'], about: 'A bright corner room with a long table and a 65-inch screen. Good for reviews and workshops.' },
    { id: 'aster', name: 'Aster', color: '#8a5bd1', floor: 3, wing: 'West wing', seats: 6, kit: ['Screen', 'Video call'], status: ['busy', 'Busy until 11:30'] },
    { id: 'hawthorn', name: 'Hawthorn', color: '#b9603d', floor: 4, wing: 'Boardroom', seats: 12, kit: ['Screen', 'Video call', 'Catering'], status: ['free', 'Free all day'] },
    { id: 'sorrel', name: 'Sorrel', color: '#d08a2c', floor: 2, wing: 'Courtyard', seats: 6, kit: ['Whiteboard'], status: ['free', 'Free until 13:00'] },
    { id: 'linden', name: 'Linden', color: '#3a9aa8', floor: 2, wing: 'Library', seats: 10, kit: ['Screen', 'Whiteboard', 'Video call'], status: ['busy', 'Busy until 12:00'] },
    { id: 'fern', name: 'Fern', color: '#4f7fd1', floor: 3, wing: 'East wing', seats: 4, kit: ['Screen'], status: ['free', 'Free until 15:30'] },
    { id: 'wren', name: 'Wren', color: '#c0587e', floor: 1, wing: 'Lobby', seats: 4, kit: ['Video call'], status: ['free', 'Free all day'] },
    { id: 'clover', name: 'Clover', color: '#6b8f3a', floor: 1, wing: 'Phone booth', seats: 2, kit: ['Quiet'], status: ['busy', 'Busy until 10:45'] },
    { id: 'moss', name: 'Moss', color: '#5e6b7a', floor: 2, wing: 'Phone booth', seats: 2, kit: ['Quiet'], status: ['free', 'Free all day'] },
  ];
  const room = (id) => ROOMS.find((r) => r.id === id);
  const BOOKINGS = [
    { day: 'Today', date: 'Wed 25 Nov', iso: '2026-11-25', start: '11:00', end: '12:00', title: 'Hiring sync', room: 'juniper', who: ['MO', 'SK', 'JR'] },
    { day: 'Today', date: 'Wed 25 Nov', iso: '2026-11-25', start: '16:30', end: '17:00', title: '1:1 with Sam', room: 'clover', who: ['MO', 'SK'] },
    { day: 'This week', date: 'Thu 26 Nov', iso: '2026-11-26', start: '10:00', end: '11:30', title: 'Roadmap workshop', room: 'hawthorn', who: ['MO', 'AL', 'PN', 'TB'] },
    { day: 'This week', date: 'Fri 27 Nov', iso: '2026-11-27', start: '09:30', end: '10:00', title: 'Weekly planning', room: 'aster', who: ['MO', 'JR', 'EV'] },
  ];
  const saved = () => { try { return JSON.parse(localStorage.getItem('larkspur:bookings') || '[]'); } catch { return []; } };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const faces = (ids, cls = 'who') => `<div class="${cls}">${ids.map((p) => `<span style="background:${PEOPLE[p] || '#888'}">${p}</span>`).join('')}</div>`;
  const app = document.getElementById('app');
  const path = location.pathname.replace(/\/+$/, '') || '/';

  const shell = (on, body) => `
    <header class="top">
      <a class="brand" href="/today">${LOGO}Larkspur</a>
      <nav class="nav"><a href="/today" class="${on === 'today' ? 'on' : ''}">Today</a><a href="/rooms" class="${on === 'rooms' ? 'on' : ''}">Rooms</a><a href="/bookings" class="${on === 'bookings' ? 'on' : ''}">Bookings</a></nav>
      <span class="grow"></span>
      <span class="search">Search rooms<kbd>⌘K</kbd></span>
      <span class="avatar" title="Maya Okafor">MO</span>
    </header>
    <main class="page">${body}</main>`;

  function signIn() {
    document.title = 'Sign in · Larkspur';
    app.innerHTML = `
      <div class="signin">
        <section class="signin-art">
          <span class="brand">${LOGO}Larkspur</span>
          <div><h1>The right room, booked in a minute.</h1><p>See what is free across every floor, book it, and get back to the work the meeting is for.</p></div>
          <div class="quote">“We stopped double-booking the boardroom the week we switched.”<b>Priya Natarajan, Office lead</b></div>
        </section>
        <section class="signin-form">
          <form id="signin" autocomplete="off">
            <h2>Sign in to Corvid Lane</h2>
            <p class="sub">Use your work email.</p>
            <label class="field"><span>Work email</span><input class="input" id="email" type="email" placeholder="you@corvidlane.example"></label>
            <label class="field"><span>Password</span><input class="input" id="password" type="password" placeholder="Your password"></label>
            <div class="row-between"><span class="check"><i></i>Keep me signed in</span><a href="#">Forgot password?</a></div>
            <button class="btn primary wide" type="submit">Sign in</button>
            <p class="or">or</p>
            <button class="btn wide" type="button">Continue with single sign-on</button>
          </form>
        </section>
      </div>`;
    document.getElementById('signin').onsubmit = (e) => { e.preventDefault(); setTimeout(() => { location.href = '/today'; }, 350); };
  }

  function today() {
    document.title = 'Today · Larkspur';
    const mine = [...saved(), ...BOOKINGS.filter((b) => b.day === 'Today')];
    const agenda = [
      ['09:30 – 10:30', 'Weekly planning', 'Juniper · 6 people', 'busy', 'Ended'],
      ['11:00 – 12:00', 'Hiring sync', 'Juniper · You and 2 others', 'mine', 'Yours'],
      ['13:00 – 14:00', 'Design critique', 'Aster · 5 people', 'busy', 'Booked'],
      ['16:30 – 17:00', '1:1 with Sam', 'Clover · You and Sam', 'mine', 'Yours'],
    ];
    app.innerHTML = shell('today', `
      <div class="head"><div><h1>Good morning, Maya</h1><p>Wednesday 25 November · Corvid Lane, Floor 3</p></div><a class="btn primary" href="/rooms">Book a room</a></div>
      <div class="stats">
        <div class="card stat next"><span class="label">Your next booking</span><span class="big">Hiring sync<br>11:00 in Juniper</span><span class="foot">In 40 minutes · ${mine.length} today</span></div>
        <div class="card stat"><span class="label">Rooms free now</span><span class="big">6 <small>of 9</small></span><div class="meter"><i style="width:66%"></i></div><span class="foot">Busiest from 13:00</span></div>
        <div class="card stat"><span class="label">In the office</span><span class="big">14</span>${faces(['SK', 'JR', 'AL', 'PN'], 'faces').replace('</div>', '<span class="more">+10</span></div>')}<span class="foot"></span></div>
        <div class="card stat"><span class="label">Bookings this week</span><span class="big">23</span><div class="bars"><i style="height:45%"></i><i style="height:70%"></i><i class="now" style="height:90%"></i><i style="height:55%"></i><i style="height:30%"></i></div></div>
      </div>
      <div class="split">
        <section class="card"><div class="panel-head"><h2>Today on Floor 3</h2><a href="/bookings">All bookings</a></div>
          <ul class="agenda">${agenda.map(([t, w, m, k, p]) => `<li><span class="time">${t}</span><span class="what"><b>${w}</b><span>${m}</span></span><span class="pill ${k}">${p}</span></li>`).join('')}</ul></section>
        <section class="card"><div class="panel-head"><h2>Free right now</h2><a href="/rooms">All rooms</a></div>
          <div class="quick">${['juniper', 'hawthorn', 'fern'].map((id) => { const r = room(id); return `<a href="/rooms/${r.id}"><span class="sw" style="background:${r.color}"></span><span><b>${r.name}</b><span>Seats ${r.seats} · ${r.status[1]}</span></span></a>`; }).join('')}</div></section>
      </div>`);
  }

  function rooms() {
    document.title = 'Rooms · Larkspur';
    const sizes = [['Any size', 0], ['2+', 2], ['4+', 4], ['6+', 6], ['10+', 10]];
    let min = 0;
    app.innerHTML = shell('rooms', `
      <div class="head"><div><h1>Rooms</h1><p>9 rooms on 4 floors · Wednesday 25 November</p></div></div>
      <div class="toolbar"><input class="input" id="q" placeholder="Search by name or floor"><div class="chips" id="chips">${sizes.map(([l, n]) => `<button class="chip${n === 0 ? ' on' : ''}" data-min="${n}">${l}</button>`).join('')}</div><span class="count" id="count"></span></div>
      <div class="card rooms" id="list"></div>`);
    const draw = () => {
      const q = document.getElementById('q').value.trim().toLowerCase();
      const list = ROOMS.filter((r) => r.seats >= min && (!q || (r.name + ' floor ' + r.floor + ' ' + r.wing).toLowerCase().includes(q)));
      document.getElementById('list').innerHTML = list.map((r) => `
        <a class="room" href="/rooms/${r.id}" data-room="${r.id}">
          <span class="sw" style="background:${r.color}">${r.name[0]}</span>
          <span><b>${r.name}</b><span class="meta">Floor ${r.floor} · ${r.wing}</span></span>
          <span class="meta">Seats ${r.seats}</span>
          <span class="tags">${r.kit.map((k) => `<span class="tag">${k}</span>`).join('')}</span>
          <span class="pill ${r.status[0]}">${r.status[1]}</span>
        </a>`).join('');
      document.getElementById('count').textContent = `${list.length} ${list.length === 1 ? 'room' : 'rooms'}`;
    };
    document.getElementById('chips').onclick = (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      min = Number(b.dataset.min);
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
      draw();
    };
    document.getElementById('q').oninput = draw;
    draw();
  }

  function oneRoom(r) {
    document.title = `${r.name} · Larkspur`;
    const seats = [[-80, -58], [-26, -58], [28, -58], [-80, 32], [-26, 32], [28, 32], [-136, -13], [84, -13]];
    const day = [['09:00', null], ['09:30', ['Weekly planning', '09:30 – 10:30']], ['10:30', null], ['11:00', ['Hiring sync', '11:00 – 12:00']], ['12:00', null], ['13:00', null], ['14:00', 'open'], ['15:00', null], ['16:00', ['Client call', '16:00 – 17:00']]];
    app.innerHTML = shell('rooms', `
      <div class="crumbs"><a href="/rooms">Rooms</a> / ${r.name}</div>
      <div class="head"><div><h1>${r.name}</h1><p>Floor ${r.floor} · ${r.wing} · Seats ${r.seats}</p></div><a class="btn primary" id="book" href="/rooms/${r.id}/book">Book ${r.name}</a></div>
      <div class="room-grid">
        <section class="card">
          <div class="plan"><span class="window"></span><span class="table"></span>${seats.map(([x, y]) => `<span class="seat" style="left:calc(50% + ${x}px);top:calc(50% + ${y}px)"></span>`).join('')}<span class="screen"></span></div>
          <div class="facts"><div><span>Seats</span><b>${r.seats} people</b></div><div><span>Floor</span><b>${r.floor}, ${r.wing}</b></div><div><span>Right now</span><b>${r.status[1]}</b></div></div>
          <p class="about">${esc(r.about || 'A quiet room for small meetings.')}</p>
          <div class="book-cta"><span class="tags">${r.kit.map((k) => `<span class="tag">${k}</span>`).join('')}</span></div>
        </section>
        <section class="card"><div class="panel-head"><h2>Today</h2><span class="pill free">Free 14:00 – 16:00</span></div>
          <div class="timeline">${day.map(([h, e]) => `<div class="slot"><span class="h">${h}</span><span class="b">${e === 'open' ? '<div class="event open">Free · 2 hours</div>' : e ? `<div class="event"><b>${e[0]}</b> · ${e[1]}</div>` : ''}</span></div>`).join('')}</div>
        </section>
      </div>`);
  }

  function book(r) {
    document.title = `Book ${r.name} · Larkspur`;
    const times = ['13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'];
    const opts = (sel) => times.map((t) => `<option${t === sel ? ' selected' : ''}>${t}</option>`).join('');
    app.innerHTML = shell('rooms', `
      <div class="crumbs"><a href="/rooms">Rooms</a> / <a href="/rooms/${r.id}">${r.name}</a> / Book</div>
      <div class="head"><div><h1>Book ${r.name}</h1><p>It’s free from 14:00 to 16:00 today.</p></div></div>
      <div class="form-grid">
        <form class="card form" id="form" autocomplete="off">
          <label class="field"><span>Room</span><div class="readonly"><i style="background:${r.color}"></i>${r.name} · Floor ${r.floor} · Seats ${r.seats}</div></label>
          <label class="field"><span>What is it for?</span><input class="input" id="title" placeholder="For example, Design review"></label>
          <div class="three">
            <label class="field"><span>Date</span><select class="input" id="date"><option>Today, Wed 25 Nov</option><option>Thu 26 Nov</option></select></label>
            <label class="field"><span>Start</span><select class="input" id="start">${opts('14:00')}</select></label>
            <label class="field"><span>End</span><select class="input" id="end">${opts('14:30')}</select></label>
          </div>
          <label class="field"><span>Who’s coming</span><input class="input" id="people" placeholder="Names or emails"></label>
          <label class="field"><span>Notes for the room</span><textarea class="input" id="notes" placeholder="Anything facilities should know"></textarea></label>
          <div class="actions"><a class="btn" href="/rooms/${r.id}">Cancel</a><button class="btn primary" id="save" type="submit">Save booking</button></div>
        </form>
        <aside class="card summary"><h2>Before you book</h2><dl><dt>Room</dt><dd>${r.name}</dd><dt>Seats</dt><dd>${r.seats}</dd><dt>Has</dt><dd>${r.kit.join(', ')}</dd><dt>Free</dt><dd>14:00 – 16:00</dd><dt>Price</dt><dd>${esc(window.LARKSPUR_PRICE || 'Included in your plan')}</dd></dl>
          <p class="hint">Bookings longer than two hours need an office lead to approve them.</p></aside>
      </div>`);
    document.getElementById('form').onsubmit = (e) => {
      e.preventDefault();
      const v = (id) => document.getElementById(id).value.trim();
      const people = v('people').split(',').map((s) => s.trim()).filter(Boolean);
      const initials = ['MO', ...people.map((p) => p.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())];
      const list = [{ day: 'Today', date: 'Wed 25 Nov', iso: '2026-11-25', start: v('start'), end: v('end'), title: v('title') || 'Meeting', room: r.id, who: initials, isNew: true }, ...saved()];
      localStorage.setItem('larkspur:bookings', JSON.stringify(list));
      setTimeout(() => { location.href = '/bookings'; }, 300);
    };
  }

  function bookings() {
    document.title = 'Bookings · Larkspur';
    const all = [...saved(), ...BOOKINGS].sort((a, b) => (a.iso + a.start).localeCompare(b.iso + b.start));
    const groups = ['Today', 'This week'].map((d) => [d, all.filter((b) => b.day === d)]);
    app.innerHTML = shell('bookings', `
      <div class="head"><div><h1>Your bookings</h1><p>${all.length} coming up · Maya Okafor</p></div><a class="btn primary" href="/rooms">Book a room</a></div>
      ${groups.map(([d, list]) => `<h2 class="group">${d}</h2><div class="card" style="overflow:hidden">${list.map((b) => { const r = room(b.room); return `
        <div class="booking${b.isNew ? ' is-new' : ''}">
          <span class="bar" style="background:${r.color}"></span>
          <span class="when">${b.start} – ${b.end}<span>${b.date}</span></span>
          <span><b>${esc(b.title)}</b>${b.isNew ? '<span class="new">New</span>' : ''}<span class="meta" style="display:block">${r.name} · Floor ${r.floor}</span></span>
          ${faces(b.who)}
          <a class="link" href="/rooms/${r.id}">View room</a>
        </div>`; }).join('')}</div>`).join('')}`);
  }

  if (path === '/' || path === '/signin') signIn();
  else if (path === '/today') today();
  else if (path === '/rooms') rooms();
  else if (path === '/bookings') bookings();
  else {
    const m = /^\/rooms\/([a-z]+)(\/book)?$/.exec(path);
    const r = m && room(m[1]);
    if (r) (m[2] ? book : oneRoom)(r);
    else app.innerHTML = shell('', '<div class="head"><div><h1>Nothing here</h1><p>That page does not exist.</p></div></div>');
  }
})();
