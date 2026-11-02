import React, { useEffect, useMemo, useRef, useState } from 'react';
import logo from '../ua-logo.png';

const STORAGE_KEYS = {
  letters: 'ua-excuse-letters-v1',
  notifications: 'ua-notifications-v1',
  assignments: 'ua-professor-assignments-v1',
  session: 'ua-demo-session',
};

const professors = [
  'Prof. Elena Cruz',
  'Prof. Mark Anthony Santos',
  'Prof. Maria Reyes',
  'Prof. Daniel Ramos',
  'Prof. Jenny Flores',
];

const courses = [
  'Data Structures',
  'Discrete Mathematics',
  'Cost Accounting',
  'General Psychology',
  'Introduction to Computing',
  'Systems Analysis',
];

const demoAccounts = {
  'mika.student@udu.ph': { password: 'UAstudent2026!', role: 'student' },
  'amara.dean@udu.ph': { password: 'UAdean2026!', role: 'dean' },
  'elena.prof@udu.ph': { password: 'UAprof2026!', role: 'professor' },
};

const people = {
  student: { name: 'Mika Santos', initials: 'MS', label: 'Student account', email: 'mika.student@udu.ph' },
  dean: { name: 'Dr. Amara Villanueva', initials: 'AV', label: 'Dean / Admin', email: 'amara.dean@udu.ph' },
  professor: { name: 'Prof. Elena Cruz', initials: 'EC', label: 'Professor account', email: 'elena.prof@udu.ph' },
};

const seedLetters = [
  { id: 'UA-2026-0418', studentName: 'Mika Santos', studentNumber: '2024-01842', program: 'BS Information Technology, 2nd year', email: 'mika.santos@ua.edu', course: 'Data Structures', professor: 'Prof. Elena Cruz', parentContact: '0917-123-4567', dateFrom: '2026-10-15', dateTo: '2026-10-15', reason: 'I was unable to attend class due to a medical consultation.', evidence: ['clinic-visit.pdf'], submitted: '2026-10-16', status: 'Pending', comment: '' },
  { id: 'UA-2026-0412', studentName: 'Jonah Reyes', studentNumber: '2023-00719', program: 'BS Accountancy, 3rd year', email: 'jonah.reyes@ua.edu', course: 'Cost Accounting', professor: 'Prof. Mark Anthony Santos', parentContact: '0922-654-1122', dateFrom: '2026-10-12', dateTo: '2026-10-12', reason: 'Family emergency required me to travel home.', evidence: ['supporting-note.jpg'], submitted: '2026-10-13', status: 'Approved', comment: 'Approved. Please coordinate any missed assessment with your professor.' },
  { id: 'UA-2026-0398', studentName: 'Aira Villanueva', studentNumber: '2025-02103', program: 'BS Psychology, 1st year', email: 'aira.v@ua.edu', course: 'General Psychology', professor: 'Prof. Jenny Flores', parentContact: '0933-889-1020', dateFrom: '2026-10-08', dateTo: '2026-10-09', reason: 'I was recovering from a fever and was advised to rest.', evidence: ['medical-certificate.pdf'], submitted: '2026-10-10', status: 'Disapproved', comment: 'Please attach a readable copy of the supporting document and resubmit.' },
  { id: 'UA-2026-0381', studentName: 'Mika Santos', studentNumber: '2024-01842', program: 'BS Information Technology, 2nd year', email: 'mika.santos@ua.edu', course: 'Discrete Mathematics', professor: 'Prof. Elena Cruz', parentContact: '0917-123-4567', dateFrom: '2026-10-02', dateTo: '2026-10-02', reason: 'I had a scheduled medical appointment.', evidence: ['appointment-slip.png'], submitted: '2026-10-03', status: 'Approved', comment: 'Approved. Thank you for providing supporting evidence.' },
];

const seedAssignments = [
  { professor: 'Prof. Elena Cruz', course: 'Data Structures' },
  { professor: 'Prof. Elena Cruz', course: 'Discrete Mathematics' },
  { professor: 'Prof. Mark Anthony Santos', course: 'Cost Accounting' },
  { professor: 'Prof. Jenny Flores', course: 'General Psychology' },
];

const seedNotifications = [
  { id: 'n1', user: 'Prof. Elena Cruz', role: 'professor', email: 'elena.prof@udu.ph', message: 'Approved excuse letter for Mika Santos is ready to review.', createdAt: '2026-10-17' },
];

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function readDemoSession() {
  try {
    const value = sessionStorage.getItem(STORAGE_KEYS.session);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getIntendedRole() {
  const queryRole = new URLSearchParams(window.location.search).get('role');
  const pathRole = window.location.pathname.slice(1).split('.')[0];
  const role = queryRole || pathRole;
  return ['student', 'dean', 'professor'].includes(role) ? role : null;
}

function getRestoredRole() {
  const stored = readDemoSession();
  if (stored && ['student', 'dean', 'professor'].includes(stored.role)
    && (!getIntendedRole() || stored.role === getIntendedRole())) return stored.role;
  if (stored) sessionStorage.removeItem(STORAGE_KEYS.session);
  return null;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dateRange(letter) {
  return letter.dateFrom === letter.dateTo
    ? formatDate(letter.dateFrom)
    : `${formatDate(letter.dateFrom)} – ${formatDate(letter.dateTo)}`;
}

function initials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function Status({ value }) {
  return <span className={`status ${value.toLowerCase()}`}>{value}</span>;
}

function StudentCell({ letter }) {
  return (
    <div className="student-cell">
      <span className="mini-avatar">{initials(letter.studentName)}</span>
      <span>
        <span className="student-name">{letter.studentName}</span>
        <span className="student-id">{letter.studentNumber}</span>
      </span>
    </div>
  );
}

function LetterTable({ items, mode, role, onOpen, emptyText }) {
  if (!items.length) return <div className="empty-state">{emptyText}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Student</th>
            {mode !== 'recent' && <th>Course</th>}
            {mode === 'history' ? <th>Submitted</th> : <th>Absence dates</th>}
            {mode !== 'history' && <th>Submitted</th>}
            <th>{mode === 'history' ? 'Decision' : 'Status'}</th>
            {mode === 'history' && <th>Dean comment</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((letter) => (
            <tr key={letter.id}>
              <td><StudentCell letter={letter} /></td>
              {mode !== 'recent' && <td>{letter.course}</td>}
              {mode === 'history' ? <td>{formatDate(letter.submitted)}</td> : <td>{dateRange(letter)}</td>}
              {mode !== 'history' && <td>{formatDate(letter.submitted)}</td>}
              <td><Status value={letter.status} /></td>
              {mode === 'history' && <td>{letter.comment || <span className="muted-dash">—</span>}</td>}
              <td><button className="review-link" type="button" onClick={() => onOpen(letter.id)}>{role === 'dean' && letter.status === 'Pending' ? 'Review' : 'Details'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QRCode({ letter }) {
  const [dataUrl, setDataUrl] = useState('');
  const payload = JSON.stringify({
    id: letter.id,
    studentName: letter.studentName,
    studentNumber: letter.studentNumber,
    course: letter.course,
    professor: letter.professor,
    status: letter.status,
    submitted: letter.submitted,
  });
  const seed = [...payload].reduce((value, char) => (value * 131 + char.charCodeAt(0)) >>> 0, 0);

  useEffect(() => {
    let active = true;
    if (window.QRCode?.toDataURL) {
      window.QRCode.toDataURL(payload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 180,
        color: { dark: '#08285f', light: '#ffffff' },
      }).then((result) => {
        if (active) setDataUrl(result);
      }).catch((error) => console.warn('QR generation failed.', error));
    }
    return () => { active = false; };
  }, [payload]);

  return (
    <div className="qr-box">
      <div className="detail-label">Verification QR</div>
      {dataUrl ? (
        <img className="qr-image" src={dataUrl} alt={`Verification QR for ${letter.id}`} />
      ) : (
        <div className="qr-grid" style={{ gridTemplateColumns: 'repeat(21, 5px)' }}>
          {Array.from({ length: 441 }, (_, index) => {
            const row = Math.floor(index / 21);
            const col = index % 21;
            const inTopLeft = row < 7 && col < 7;
            const inTopRight = row < 7 && col >= 14;
            const inBottomLeft = row >= 14 && col < 7;
            const inFinder = inTopLeft || inTopRight || inBottomLeft;
            const finderRow = inBottomLeft ? row - 14 : row;
            const finderCol = inTopRight ? col - 14 : col;
            const finderPixel = finderRow === 0 || finderRow === 6 || finderCol === 0 || finderCol === 6
              || (finderRow >= 2 && finderRow <= 4 && finderCol >= 2 && finderCol <= 4);
            const value = inFinder ? finderPixel : (seed + row * 97 + col * 131 + row * col) % 11 % 2 === 0;
            return <span className={`qr-cell${value ? ' active' : ''}`} key={index} />;
          })}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const intendedRole = useMemo(getIntendedRole, []);
  const [role, setRole] = useState(getRestoredRole);
  const [letters, setLetters] = useState(() => readStored(STORAGE_KEYS.letters, seedLetters));
  const [notifications, setNotifications] = useState(() => readStored(STORAGE_KEYS.notifications, seedNotifications));
  const [assignments, setAssignments] = useState(() => readStored(STORAGE_KEYS.assignments, seedAssignments));
  const [screen, setScreen] = useState('dashboard');
  const [loginError, setLoginError] = useState('');
  const [currentLetterId, setCurrentLetterId] = useState(null);
  const [decisionComment, setDecisionComment] = useState('');
  const [selectedEvidence, setSelectedEvidence] = useState([]);
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [historySearch, setHistorySearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [assignmentProfessor, setAssignmentProfessor] = useState(professors[0]);
  const [assignmentCourse, setAssignmentCourse] = useState(courses[0]);
  const toastTimer = useRef(null);
  const profile = people[role || 'student'];
  const visibleLetters = role === 'student'
    ? letters.filter((letter) => letter.studentName === 'Mika Santos')
    : role === 'professor'
      ? letters.filter((letter) => letter.status === 'Approved' && letter.professor === profile.name)
      : letters;

  function showToast(message) {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }

  function persist(key, value, message) {
    try {
      writeStored(key, value);
      return true;
    } catch {
      showToast(message);
      return false;
    }
  }

  function changeLetters(next) {
    if (persist(STORAGE_KEYS.letters, next, 'Could not save this letter. Try fewer or smaller image files.')) {
      setLetters(next);
      return true;
    }
    return false;
  }

  function changeNotifications(next) {
    if (persist(STORAGE_KEYS.notifications, next, 'Could not save the notification.')) setNotifications(next);
  }

  function navigate(nextScreen) {
    if (nextScreen === 'submit' && role !== 'student') return;
    setScreen(nextScreen);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleLogin(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email')).trim().toLowerCase();
    const account = demoAccounts[email];
    if (!account || account.password !== data.get('password')) {
      setLoginError('Email or password is incorrect.');
      return;
    }
    if (intendedRole && account.role !== intendedRole) {
      setLoginError(`This page is for the ${intendedRole === 'dean' ? 'Dean / Admin' : intendedRole} account. Sign in with that account.`);
      return;
    }
    const nextSession = { email, role: account.role };
    try {
      sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(nextSession));
      setRole(account.role);
      setScreen('dashboard');
      window.history.replaceState({}, '', `/${account.role}`);
    } catch {
      setLoginError('Could not start your demo session. Check browser storage and try again.');
    }
  }

  function logout() {
    sessionStorage.removeItem(STORAGE_KEYS.session);
    setRole(null);
    setScreen('dashboard');
    window.history.replaceState({}, '', '/');
  }

  function openLetter(id) {
    setCurrentLetterId(id);
    setDecisionComment('');
  }

  function decideLetter(status) {
    if (role !== 'dean' || !['Approved', 'Disapproved'].includes(status)) return;
    const letter = letters.find((item) => item.id === currentLetterId && item.status === 'Pending');
    if (!letter) return;
    const decidedLetter = { ...letter, status, comment: decisionComment.trim() };
    const nextLetters = letters.map((item) => item.id === letter.id ? decidedLetter : item);
    if (!changeLetters(nextLetters)) return;
    const nextNotifications = [
      ...(status === 'Approved' ? [{
        id: crypto.randomUUID(),
        user: letter.professor,
        role: 'professor',
        email: letter.professor === 'Prof. Elena Cruz' ? 'elena.prof@udu.ph' : 'assigned.professor@udu.ph',
        message: `Approved excuse letter ${letter.id} is ready for ${letter.studentName}.`,
        createdAt: new Date().toISOString().slice(0, 10),
      }] : []),
      {
        id: crypto.randomUUID(),
        user: letter.studentName,
        role: 'student',
        email: letter.email || 'student@udu.ph',
        message: status === 'Approved'
          ? `Your excuse letter ${letter.id} was approved by the Dean.`
          : `Your excuse letter ${letter.id} was disapproved. Please review the Dean's notes.`,
        createdAt: new Date().toISOString().slice(0, 10),
      },
      ...notifications,
    ];
    changeNotifications(nextNotifications);
    setCurrentLetterId(null);
    showToast(`Letter ${letter.id} ${status.toLowerCase()}. Email notifications were prepared for the student and professor.`);
  }

  async function handleEvidence(event) {
    const files = [...event.target.files];
    event.target.value = '';
    if (selectedEvidence.length + files.length > 3) {
      showToast('Attach up to 3 evidence files per letter.');
      return;
    }
    if (files.some((file) => file.size > 8 * 1024 * 1024)) {
      showToast('Each evidence file must be smaller than 8 MB.');
      return;
    }
    try {
      const additions = [];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          const bitmap = await createImageBitmap(file);
          const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          additions.push({ name: file.name, type: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', 0.78) });
        } else {
          additions.push({ name: file.name, type: file.type || 'application/pdf' });
        }
      }
      setSelectedEvidence((current) => [...current, ...additions]);
    } catch {
      showToast('Could not read that image. Try a JPG or PNG file.');
    }
  }

  function handleSubmitLetter(event) {
    event.preventDefault();
    if (role !== 'student') {
      showToast('Only student accounts can submit excuse letters.');
      return;
    }
    const data = new FormData(event.currentTarget);
    const from = String(data.get('dateFrom'));
    const to = String(data.get('dateTo'));
    if (to < from) {
      showToast('The end date must be on or after the start date.');
      return;
    }
    const nextNumber = String(420 + letters.length + 1).padStart(4, '0');
    const nextLetter = {
      id: `UA-2026-${nextNumber}`,
      studentName: String(data.get('studentName')).trim(),
      studentNumber: String(data.get('studentNumber')).trim(),
      program: String(data.get('program')).trim(),
      email: String(data.get('email')).trim(),
      course: String(data.get('course')).trim(),
      professor: String(data.get('professor')).trim(),
      parentContact: String(data.get('parentContact')).trim(),
      dateFrom: from,
      dateTo: to,
      reason: String(data.get('reason')).trim(),
      evidence: selectedEvidence,
      submitted: new Date().toISOString().slice(0, 10),
      status: 'Pending',
      comment: '',
    };
    if (!changeLetters([nextLetter, ...letters])) return;
    event.currentTarget.reset();
    setSelectedEvidence([]);
    navigate('letters');
    showToast('Your letter was submitted to the Dean for review.');
  }

  function saveAssignment() {
    if (!assignmentProfessor || !assignmentCourse) return;
    if (assignments.some((item) => item.professor === assignmentProfessor && item.course === assignmentCourse)) return;
    const next = [{ professor: assignmentProfessor, course: assignmentCourse }, ...assignments];
    if (persist(STORAGE_KEYS.assignments, next, 'Could not save the professor assignment.')) {
      setAssignments(next);
      showToast(`${assignmentProfessor} assigned to ${assignmentCourse}.`);
    }
  }

  const sortedLetters = [...visibleLetters].sort((a, b) => b.submitted.localeCompare(a.submitted));
  const dashboardLetters = role === 'dean' ? sortedLetters.filter((letter) => letter.status === 'Pending') : sortedLetters;
  const matches = (letter, text, status) => (!text || `${letter.studentName} ${letter.studentNumber} ${letter.course} ${letter.professor}`.toLowerCase().includes(text.toLowerCase()))
    && (status === 'all' || letter.status === status);
  const allLetters = sortedLetters.filter((letter) => matches(letter, search, filter));
  const historyLetters = sortedLetters.filter((letter) => matches(letter, historySearch, historyFilter));
  const pendingCount = role === 'dean'
    ? letters.filter((letter) => letter.status === 'Pending').length
    : role === 'professor' ? visibleLetters.length : visibleLetters.filter((letter) => letter.status === 'Pending').length;
  const activeLetter = letters.find((letter) => letter.id === currentLetterId);

  if (!role) {
    return (
      <section className="login-screen">
        <div className="login-aside">
          <div className="login-brand"><img src={logo} alt="University of the Assumption seal" /><div><div className="login-brand-name">University of the Assumption</div><div className="login-brand-sub">Student Affairs · San Fernando, Pampanga</div></div></div>
          <div className="login-message"><div className="eyebrow">Digital student services</div><h1>Welcome to your excuse letter desk.</h1><p>Sign in with your university account to submit, review, or access approved excuse letters.</p></div>
          <div className="login-footer">Academic year 2026-2027 · University of the Assumption</div>
        </div>
        <div className="login-panel">
          <form className="login-card" onSubmit={handleLogin}>
            <div className="eyebrow">Account access</div><h2>Sign in</h2>
            <p>{intendedRole ? `Sign in with the account assigned to the ${intendedRole === 'dean' ? 'Dean / Admin' : intendedRole} portal.` : 'Use the account assigned to your university role.'}</p>
            <div className="field"><label htmlFor="login-email">University email</label><input id="login-email" name="email" type="email" autoComplete="username" required placeholder="name@udu.ph" /></div>
            <div className="field"><label htmlFor="login-password">Password</label><input id="login-password" name="password" type="password" autoComplete="current-password" required placeholder="Enter your password" /></div>
            <button className="primary login-submit" type="submit">Sign in</button>
            <p className="login-error" role="alert">{loginError}</p>
            <details className="demo-access"><summary>Show demo account credentials</summary><div className="demo-accounts">
              <div className="demo-account"><strong>Student</strong><br /><code>mika.student@udu.ph</code><br /><code>UAstudent2026!</code></div>
              <div className="demo-account"><strong>Dean / Admin</strong><br /><code>amara.dean@udu.ph</code><br /><code>UAdean2026!</code></div>
              <div className="demo-account"><strong>Professor</strong><br /><code>elena.prof@udu.ph</code><br /><code>UAprof2026!</code></div>
            </div></details>
          </form>
        </div>
      </section>
    );
  }

  const roleCopy = {
    student: ['Good morning, Mika.', 'Your excuse letters, all in one place.', 'Recent letters', 'A quick look at your latest submissions', 'Excuse letters', 'Your submissions and their current status.', 'My letters'],
    dean: ['Good morning, Dean.', 'Review requests and record decisions.', 'Needs your review', 'Pending requests are ready for a decision', 'Review letters', 'Review submissions and record a decision with an optional comment.', 'Review queue'],
    professor: ['Good morning, Professor.', 'Approved excuse letters for your classes.', 'Approved for your class', 'Approved requests assigned to you', 'Approved letters', 'Only Dean-approved letters assigned to your classes appear here.', 'Approved letters'],
  }[role];
  const statuses = ['all', 'Pending', 'Approved', 'Disapproved'];

  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand"><img className="brand-mark" src={logo} alt="University of the Assumption seal" /><div><div className="brand-name">University of the<br />Assumption</div><div className="brand-sub">Pampanga · Student Affairs</div></div></div>
          <div className="side-label">Workspace</div>
          <nav className="nav" aria-label="Main navigation">
            {[['dashboard', 'OV', 'Overview'], ['letters', 'EL', roleCopy[6]], ...(role !== 'professor' ? [['history', 'HI', 'Letter history']] : [])].map(([key, icon, label]) => (
              <button className={screen === key || (screen === 'submit' && key === 'letters') ? 'active' : ''} data-screen={key} key={key} onClick={() => navigate(key)} type="button">
                <span className="nav-icon">{icon}</span>{label}{key === 'letters' && <span className="nav-count">{pendingCount}</span>}
              </button>
            ))}
          </nav>
          <div className="side-foot"><strong>University of the Assumption</strong><br />San Fernando, Pampanga<br />Academic year 2026-2027</div>
        </aside>
        <main>
          <header className="topbar">
            <div className="crumb">Student Affairs <span aria-hidden="true">/</span> <b>{({ dashboard: 'Overview', letters: roleCopy[4], history: 'Letter history', submit: 'New submission' })[screen]}</b></div>
            <div className="top-actions"><div className="user-chip"><div className="avatar">{profile.initials}</div><div><div className="user-name">{profile.name}</div><div className="user-role">{profile.label}</div></div></div><button className="secondary" onClick={logout} type="button">Sign out</button></div>
          </header>
          <div className="content">
            {screen === 'dashboard' && (
              <section className="screen active">
                <div className="page-heading"><div><div className="eyebrow">University of the Assumption · San Fernando, Pampanga</div><h1>{roleCopy[0]}</h1><p className="subtitle">{roleCopy[1]}</p></div>{role === 'student' && <button className="primary" onClick={() => navigate('submit')} type="button">+ &nbsp; New excuse letter</button>}</div>
                <div className="stats">
                  {[
                    ['Total letters', visibleLetters.length, 'Across your records', 'EL'],
                    ['Awaiting review', visibleLetters.filter((item) => item.status === 'Pending').length, 'In the Dean’s queue', '…'],
                    ['Approved', visibleLetters.filter((item) => item.status === 'Approved').length, 'Ready to view', 'OK'],
                    ['Disapproved', visibleLetters.filter((item) => item.status === 'Disapproved').length, 'See Dean comments', 'NO'],
                  ].map(([label, value, note, mark]) => <div className="stat" key={label}><div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></div><div className="stat-mark">{mark}</div></div>)}
                </div>
                <div className="workspace">
                  <section className="panel"><div className="panel-head"><div><div className="panel-title">{roleCopy[2]}</div><div className="panel-kicker">{roleCopy[3]}</div></div>{role !== 'professor' && <button className="secondary" onClick={() => navigate('history')} type="button">View history</button>}</div>
                    <LetterTable items={dashboardLetters.slice(0, 5)} mode="recent" role={role} onOpen={openLetter} emptyText="Nothing here yet. New letters will appear as they are submitted." />
                  </section>
                  <aside className="right-col">
                    <section className="notice"><div className="notice-title">Paperwork, without the paper.</div><p>Submit an excuse letter once. Student Affairs reviews it, and your professor can see it as soon as it is approved.</p>{role === 'student' && <button className="secondary" onClick={() => navigate('submit')} type="button">Start a letter &nbsp; →</button>}</section>
                    <section className="panel"><div className="panel-head"><div><div className="panel-title">Latest activity</div><div className="panel-kicker">Updates from the letter desk</div></div></div><Activity items={visibleLetters} notifications={notifications} role={role} profile={profile} /></section>
                    {role === 'dean' && <section className="panel assignment-panel"><div className="panel-head"><div><div className="panel-title">Professor assignments</div><div className="panel-kicker">Manage professor-to-course pairing</div></div></div>
                      <div className="assignment-list">{assignments.map((item) => <div className="assignment-item" key={`${item.professor}-${item.course}`}><div><strong>{item.professor}</strong><small>{item.course}</small></div><span className="status approved">Assigned</span></div>)}</div>
                      <div className="assignment-form"><div className="row"><div className="field"><label htmlFor="assignment-professor">Professor</label><select id="assignment-professor" value={assignmentProfessor} onChange={(event) => setAssignmentProfessor(event.target.value)}>{professors.map((name) => <option key={name}>{name}</option>)}</select></div><div className="field"><label htmlFor="assignment-course">Course</label><select id="assignment-course" value={assignmentCourse} onChange={(event) => setAssignmentCourse(event.target.value)}>{courses.map((course) => <option key={course}>{course}</option>)}</select></div></div><button className="primary" onClick={saveAssignment} type="button">Assign professor</button></div>
                    </section>}
                  </aside>
                </div>
              </section>
            )}
            {screen === 'letters' && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Excuse letter desk</div><h1>{roleCopy[4]}</h1><p className="subtitle">{roleCopy[5]}</p></div>{role === 'student' && <button className="primary" onClick={() => navigate('submit')} type="button">+ &nbsp; New excuse letter</button>}</div>
              <section className="panel"><div className="panel-head"><div><div className="panel-title">All letters</div><div className="panel-kicker">{sortedLetters.length} letter{sortedLetters.length === 1 ? '' : 's'} in this view</div></div><div className="table-tools"><input className="search" type="search" placeholder="Search names or course" aria-label="Search letters" value={search} onChange={(event) => setSearch(event.target.value)} /><select className="filter" aria-label="Filter by status" value={filter} onChange={(event) => setFilter(event.target.value)}>{statuses.map((status) => <option key={status} value={status}>{status === 'all' ? 'All statuses' : status}</option>)}</select></div></div>
                <LetterTable items={allLetters} mode="all" role={role} onOpen={openLetter} emptyText="No letters match this view." />
              </section>
            </section>}
            {screen === 'history' && role !== 'professor' && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Records & decisions</div><h1>Letter history</h1><p className="subtitle">A record of submissions, decisions, and Dean comments.</p></div></div>
              <section className="panel"><div className="panel-head"><div><div className="panel-title">Complete record</div><div className="panel-kicker">{sortedLetters.length} complete record{sortedLetters.length === 1 ? '' : 's'}</div></div><div className="table-tools"><input className="search" type="search" placeholder="Search history" aria-label="Search history" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} /><select className="filter" aria-label="Filter history by status" value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)}>{statuses.map((status) => <option key={status} value={status}>{status === 'all' ? 'All statuses' : status}</option>)}</select></div></div>
                <LetterTable items={historyLetters} mode="history" role={role} onOpen={openLetter} emptyText="No letters to show yet." />
              </section>
            </section>}
            {screen === 'submit' && role === 'student' && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Student services · New request</div><h1>Submit an excuse letter</h1><p className="subtitle">Complete the form as it should appear on your school excuse letter.</p></div></div>
              <div className="letter-layout">
                <form className="panel form-panel" onSubmit={handleSubmitLetter}>
                  <div className="form-section"><h2 className="section-title">Student information</h2><div className="form-grid">
                    <div className="field"><label htmlFor="student-name">Full name *</label><input id="student-name" name="studentName" required placeholder="First and last name" /></div>
                    <div className="field"><label htmlFor="student-number">Student number *</label><input id="student-number" name="studentNumber" required placeholder="e.g. 2024-01234" /></div>
                    <div className="field"><label htmlFor="program">Program / year level *</label><input id="program" name="program" required placeholder="e.g. BSIT, 2nd year" /></div>
                    <div className="field"><label htmlFor="email">School email *</label><input id="email" name="email" type="email" required placeholder="name@school.edu" /></div>
                  </div></div>
                  <div className="form-section"><h2 className="section-title">Class and absence</h2><div className="form-grid">
                    <div className="field"><label htmlFor="course">Course / subject *</label><input id="course" name="course" list="course-options" required placeholder="e.g. Introduction to Computing" /><datalist id="course-options">{courses.map((course) => <option key={course} value={course} />)}</datalist></div>
                    <div className="field"><label htmlFor="professor">Assigned professor *</label><input id="professor" name="professor" list="professor-options" required placeholder="Type professor name" /><datalist id="professor-options">{professors.map((name) => <option key={name} value={name} />)}</datalist></div>
                    <div className="field"><label htmlFor="date-from">Absence from *</label><input id="date-from" name="dateFrom" type="date" required /></div>
                    <div className="field"><label htmlFor="date-to">Absence to *</label><input id="date-to" name="dateTo" type="date" required /></div>
                    <div className="field"><label htmlFor="parent-contact">Parent/guardian contact number *</label><input id="parent-contact" name="parentContact" required placeholder="e.g. 0917-123-4567" /></div>
                    <div className="field full"><label htmlFor="reason">Reason for absence *</label><textarea id="reason" name="reason" required placeholder="Briefly explain the reason for your absence" /></div>
                  </div></div>
                  <div className="form-section"><h2 className="section-title">Supporting evidence</h2><div className="field"><label htmlFor="evidence">Attach supporting pictures or documents</label><div className="upload">Choose up to 3 images or PDFs, max 8 MB each<input id="evidence" name="evidence" type="file" accept="image/*,.pdf" multiple onChange={handleEvidence} /></div><div className="field-hint">Images are saved in this browser and visible to reviewers. PDFs show their filename only in this demo.</div><div className="evidence-preview" aria-live="polite">{selectedEvidence.map((item, index) => <div className="evidence-item" key={`${item.name}-${index}`}>{item.dataUrl ? <img src={item.dataUrl} alt={`Image preview: ${item.name}`} /> : <span className="evidence-name">PDF document</span>}<span className="evidence-name">{item.name}</span><button className="evidence-remove" type="button" onClick={() => setSelectedEvidence((current) => current.filter((_, position) => position !== index))} aria-label={`Remove ${item.name}`}>×</button></div>)}</div></div></div>
                  <div className="form-actions"><button type="button" className="secondary" onClick={() => navigate('dashboard')}>Cancel</button><button className="primary" type="submit">Submit to Dean &nbsp; →</button></div>
                </form>
                <aside className="panel side-note"><h3>What happens next</h3><p>Your request goes to the Dean for review. Once a decision is made, the status and any comment appear in your history.</p><div className="steps"><div className="step"><div className="step-number">1</div><div><strong>Submit your request</strong>Fill in the details and attach relevant evidence.</div></div><div className="step"><div className="step-number">2</div><div><strong>Dean reviews it</strong>Student Affairs approves or declines with an optional note.</div></div><div className="step"><div className="step-number">3</div><div><strong>Professor is notified</strong>Approved letters become visible to the assigned professor.</div></div></div></aside>
              </div>
            </section>}
          </div>
        </main>
      </div>
      <div className={`modal-backdrop${activeLetter ? ' open' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={(event) => { if (event.target === event.currentTarget) setCurrentLetterId(null); }}>
        {activeLetter && <div className="modal"><div className="modal-head"><div><h2 id="modal-title">{activeLetter.studentName}</h2><p>{activeLetter.id} · Submitted {formatDate(activeLetter.submitted)}</p></div><button className="close" onClick={() => setCurrentLetterId(null)} aria-label="Close" type="button">×</button></div>
          <div className="modal-content"><div className="detail-grid">
            <Detail label="Student number" value={activeLetter.studentNumber} /><Detail label="Program / year" value={activeLetter.program} /><Detail label="School email" value={activeLetter.email} /><Detail label="Parent / guardian" value={activeLetter.parentContact || 'Not provided'} />
            <div><div className="detail-label">Status</div><div className="detail-value"><Status value={activeLetter.status} /></div></div><Detail label="Course" value={activeLetter.course} /><Detail label="Assigned professor" value={activeLetter.professor} /><Detail label="Absence dates" value={dateRange(activeLetter)} />
            <div><div className="detail-label">Evidence</div><div className="detail-value"><div className="review-evidence">{(activeLetter.evidence || []).length ? activeLetter.evidence.map((item, index) => { const evidence = typeof item === 'string' ? { name: item } : item; return <Evidence key={`${evidence.name}-${index}`} item={evidence} />; }) : <span>No evidence attached</span>}</div></div></div>
            <div className="detail-full"><div className="detail-label">Reason</div><div className="detail-value">{activeLetter.reason}</div></div>
          </div>
          {activeLetter.comment && <div className="comment-box"><strong>Dean’s comment</strong><br />{activeLetter.comment}</div>}
          <div className="qr-center"><QRCode letter={activeLetter} /></div>
          </div>
          <div className="modal-actions">{role === 'dean' && activeLetter.status === 'Pending' ? <><div className="comment-field"><textarea aria-label="Optional comment for the student" placeholder="Optional comment for the student" value={decisionComment} onChange={(event) => setDecisionComment(event.target.value)} /></div><div className="action-right"><button className="danger" onClick={() => decideLetter('Disapproved')} type="button">Disapprove</button><button className="approve" onClick={() => decideLetter('Approved')} type="button">Approve</button></div></> : <><button className="secondary" onClick={() => setCurrentLetterId(null)} type="button">Close</button><span className="modal-hint">{activeLetter.status === 'Approved' ? 'Visible to assigned professor' : activeLetter.status === 'Pending' ? 'Awaiting Dean review' : 'See the comment above for next steps'}</span></>}</div>
        </div>}
      </div>
      <div className={`toast${toast ? ' show' : ''}`} role="status">{toast}</div>
    </>
  );
}

function Detail({ label, value }) {
  return <div><div className="detail-label">{label}</div><div className="detail-value">{value || '—'}</div></div>;
}

function Evidence({ item }) {
  if (item.dataUrl) {
    return <a href={item.dataUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open image evidence ${item.name}`}><img src={item.dataUrl} alt={`Evidence: ${item.name}`} /><span>{item.name}</span></a>;
  }
  return <span>{item.name}</span>;
}

function Activity({ items, notifications, role, profile }) {
  if (role === 'professor' || role === 'dean') {
    const list = role === 'professor'
      ? notifications.filter((item) => item.email === profile.email || item.user === profile.name).slice(0, 4)
      : notifications.slice(0, 3);
    return list.length ? <div className="notification-list">{list.map((item) => <div className="notification-item" key={item.id}><strong>{item.message}</strong><small>{role === 'dean' ? item.user : item.email || 'Email not set'} · {formatDate(item.createdAt)}</small></div>)}</div> : <div className="empty-state">No notifications yet.</div>;
  }
  const recent = [...items].sort((a, b) => b.submitted.localeCompare(a.submitted)).slice(0, 3);
  return recent.length ? <div className="activity">{recent.map((letter) => <div className="activity-item" key={letter.id}><div className="activity-dot">{letter.status === 'Approved' ? '✓' : letter.status === 'Pending' ? '…' : '!'}</div><div><div className="activity-text"><strong>{letter.id}</strong> · {letter.studentName}<br />{letter.status}{letter.comment ? `: ${letter.comment}` : ''}</div><div className="activity-time">Submitted {formatDate(letter.submitted)}</div></div></div>)}</div> : <div className="empty-state">No recent activity.</div>;
}
