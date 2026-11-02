import React, { useEffect, useRef, useState } from 'react';
import logo from '../ua-logo.png';
import { getSupabaseClient, isSupabaseConfigured } from './lib/supabase.js';
import { getProfileForUser, profileRoles } from './services/profile.js';
import {
  createStudentLetter,
  getStudentCourses,
  getStudentLetterDetails,
  getStudentLetters,
} from './services/studentLetters.js';

const STORAGE_KEYS = {
  letters: 'ua-excuse-letters-v1',
  notifications: 'ua-notifications-v1',
  assignments: 'ua-professor-assignments-v1',
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

function writeStored(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function authFailureMessage(error, signingIn = false, profileLookup = false) {
  const message = String(error?.message || '').toLowerCase();
  if (profileLookup) {
    if (error?.name === 'AuthRetryableFetchError' || error instanceof TypeError || message.includes('fetch')) {
      return 'Could not reach the profile service. Check your internet connection and try again.';
    }
    return 'Could not load your profile. Check your connection and try again.';
  }
  if (signingIn && (error?.status === 400 || error?.code === 'invalid_credentials' || message.includes('invalid login credentials'))) {
    return 'Email or password is incorrect.';
  }
  if (error?.name === 'AuthRetryableFetchError' || error instanceof TypeError || message.includes('fetch')) {
    return 'Could not reach the sign-in service. Check your internet connection and try again.';
  }
  return signingIn
    ? 'Could not sign in right now. Please try again.'
    : 'Could not verify your sign-in session. Check your connection and retry.';
}

function formatDate(value) {
  if (!value) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function dateRange(letter) {
  return letter.dateFrom === letter.dateTo
    ? formatDate(letter.dateFrom)
    : `${formatDate(letter.dateFrom)} – ${formatDate(letter.dateTo)}`;
}

function toStudentLetterView(letter, profile, authUser) {
  const course = letter.course_offerings;
  const courseName = course
    ? `${course.course_code} · ${course.course_name}${course.section ? ` (${course.section})` : ''}`
    : 'Course unavailable';

  return {
    id: letter.id,
    studentName: profile?.full_name || authUser?.email || 'Student',
    studentNumber: profile?.student_number || 'Student number not provided',
    program: profile?.program || 'Program not provided',
    email: authUser?.email || '',
    course: courseName,
    professor: '',
    parentContact: '',
    dateFrom: letter.absence_start,
    dateTo: letter.absence_end,
    reason: letter.reason,
    evidence: [],
    submitted: letter.submitted_at,
    status: letter.status.charAt(0).toUpperCase() + letter.status.slice(1),
    comment: letter.dean_comment || '',
  };
}

function studentDataFailureMessage(error) {
  if (import.meta.env.DEV) console.error('Student excuse-letter request failed.', error);
  if (error?.code === '42501' || error?.code === 'PGRST301') {
    return 'You do not have permission to access this student data. Refresh your session or contact support.';
  }
  if (error?.code === '23503') {
    return 'The selected course is no longer available for your enrollment. Refresh your courses and try again.';
  }
  if (error instanceof TypeError || error?.name === 'AuthRetryableFetchError') {
    return 'Could not reach the student services database. Check your connection and try again.';
  }
  return 'Could not load or save student records. Please try again.';
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

function LetterTable({ items, mode, profileRole, onOpen, emptyText }) {
  if (!items.length) return <div className="empty-state">{emptyText}</div>;
  if (mode === 'student') {
    return (
      <div className="table-wrap">
        <table>
          <thead><tr><th>Course</th><th>Absence dates</th><th>Reason</th><th>Submitted</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.map((letter) => (
              <tr key={letter.id}>
                <td>{letter.course}</td>
                <td>{dateRange(letter)}</td>
                <td className="student-reason">{letter.reason}</td>
                <td>{formatDate(letter.submitted)}</td>
                <td><Status value={letter.status} /></td>
                <td><button className="review-link" type="button" onClick={() => onOpen(letter.id)}>Details</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
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
              <td><button className="review-link" type="button" onClick={() => onOpen(letter.id)}>{profileRole === 'dean' && letter.status === 'Pending' ? 'Review' : 'Details'}</button></td>
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
  const [authUser, setAuthUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileRole, setProfileRole] = useState(null);
  const [studentCourses, setStudentCourses] = useState([]);
  const [studentCoursesStatus, setStudentCoursesStatus] = useState('idle');
  const [studentCoursesError, setStudentCoursesError] = useState('');
  const [studentLetters, setStudentLetters] = useState([]);
  const [studentLettersStatus, setStudentLettersStatus] = useState('idle');
  const [studentLettersError, setStudentLettersError] = useState('');
  const [studentRefreshVersion, setStudentRefreshVersion] = useState(0);
  const [studentSubmitting, setStudentSubmitting] = useState(false);
  const [studentSubmitError, setStudentSubmitError] = useState('');
  const [studentDetail, setStudentDetail] = useState(null);
  const [studentDetailStatus, setStudentDetailStatus] = useState('idle');
  const [studentDetailError, setStudentDetailError] = useState('');
  const [authStatus, setAuthStatus] = useState('checking-session');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authCheckVersion, setAuthCheckVersion] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [letters, setLetters] = useState(() => readStored(STORAGE_KEYS.letters, seedLetters));
  const [notifications, setNotifications] = useState(() => readStored(STORAGE_KEYS.notifications, seedNotifications));
  const [assignments, setAssignments] = useState(() => readStored(STORAGE_KEYS.assignments, seedAssignments));
  const [screen, setScreen] = useState('dashboard');
  const [currentLetterId, setCurrentLetterId] = useState(null);
  const [decisionComment, setDecisionComment] = useState('');
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [historySearch, setHistorySearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [assignmentProfessor, setAssignmentProfessor] = useState(professors[0]);
  const [assignmentCourse, setAssignmentCourse] = useState(courses[0]);
  const toastTimer = useRef(null);
  const authResolutionId = useRef(0);
  const studentDetailRequestId = useRef(0);
  const displayName = profile?.full_name || authUser?.email || 'University user';
  const displayInitials = initials(displayName);
  const visibleLetters = profileRole === 'student'
    ? studentLetters.map((letter) => toStudentLetterView(letter, profile, authUser))
    : profileRole === 'professor'
      ? letters.filter((letter) => letter.status === 'Approved' && letter.professor === 'Prof. Elena Cruz')
      : letters;

  useEffect(() => {
    let active = true;
    if (!isSupabaseConfigured) {
      setAuthStatus('missing-configuration');
      return () => { active = false; };
    }

    let client;
    try {
      client = getSupabaseClient();
    } catch {
      setAuthStatus('missing-configuration');
      return () => { active = false; };
    }

    const resolveSession = async (session) => {
      const requestId = ++authResolutionId.current;
      const user = session?.user ?? null;
      setAuthError('');
      setAuthUser(user);
      setProfile(null);
      setProfileRole(null);

      if (!user) {
        setAuthStatus('ready');
        setScreen('dashboard');
        return;
      }

      setAuthStatus('loading-profile');
      try {
        const userProfile = await getProfileForUser(user.id);
        if (!active || requestId !== authResolutionId.current) return;
        if (!userProfile) {
          setAuthStatus('missing-profile');
          return;
        }
        if (!profileRoles.includes(userProfile.role)) {
          setAuthStatus('invalid-role');
          return;
        }
        setProfile(userProfile);
        setProfileRole(userProfile.role);
        setAuthStatus('ready');
      } catch (error) {
        if (!active || requestId !== authResolutionId.current) return;
        setAuthError(authFailureMessage(error, false, true));
        setAuthStatus('profile-error');
      }
    };

    const initialRequestId = ++authResolutionId.current;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' || !active) return;
      window.setTimeout(() => {
        if (active) void resolveSession(session);
      }, 0);
    });

    client.auth.getSession()
      .then(({ data: { session }, error }) => {
        if (!active || initialRequestId !== authResolutionId.current) return;
        if (error) {
          setAuthUser(null);
          setProfile(null);
          setProfileRole(null);
          setAuthError(authFailureMessage(error));
          setAuthStatus('error');
          return;
        }
        void resolveSession(session);
      })
      .catch((error) => {
        if (!active || initialRequestId !== authResolutionId.current) return;
        setAuthUser(null);
        setProfile(null);
        setProfileRole(null);
        setAuthError(authFailureMessage(error));
        setAuthStatus('error');
      });

    return () => {
      active = false;
      authResolutionId.current += 1;
      subscription.unsubscribe();
    };
  }, [authCheckVersion]);

  useEffect(() => {
    let active = true;
    if (profileRole !== 'student' || !authUser?.id) {
      setStudentCourses([]);
      setStudentCoursesStatus('idle');
      setStudentCoursesError('');
      setStudentLetters([]);
      setStudentLettersStatus('idle');
      setStudentLettersError('');
      return () => { active = false; };
    }

    setStudentCourses([]);
    setStudentCoursesStatus('loading');
    setStudentCoursesError('');
    setStudentLetters([]);
    setStudentLettersStatus('loading');
    setStudentLettersError('');

    getStudentCourses(authUser.id)
      .then((coursesForStudent) => {
        if (!active) return;
        setStudentCourses(coursesForStudent);
        setStudentCoursesStatus('ready');
      })
      .catch((error) => {
        if (!active) return;
        setStudentCoursesError(studentDataFailureMessage(error));
        setStudentCoursesStatus('error');
      });

    getStudentLetters(authUser.id)
      .then((lettersForStudent) => {
        if (!active) return;
        setStudentLetters(lettersForStudent);
        setStudentLettersStatus('ready');
      })
      .catch((error) => {
        if (!active) return;
        setStudentLettersError(studentDataFailureMessage(error));
        setStudentLettersStatus('error');
      });

    return () => { active = false; };
  }, [authUser?.id, profileRole, studentRefreshVersion]);

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
    if (nextScreen === 'submit' && profileRole !== 'student') return;
    setScreen(nextScreen);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (!isSupabaseConfigured || authLoading) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email')).trim().toLowerCase();
    const password = String(data.get('password'));
    data.delete('password');
    form.reset();
    setAuthLoading(true);
    setAuthError('');
    try {
      const { data: { session }, error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
      if (error) {
        setAuthError(authFailureMessage(error, true));
        return;
      }
      if (session?.user) {
        const requestId = ++authResolutionId.current;
        setAuthUser(session.user);
        setProfile(null);
        setProfileRole(null);
        setAuthStatus('loading-profile');
        try {
          const userProfile = await getProfileForUser(session.user.id);
          if (requestId !== authResolutionId.current) return;
          if (!userProfile) {
            setAuthStatus('missing-profile');
          } else if (!profileRoles.includes(userProfile.role)) {
            setAuthStatus('invalid-role');
          } else {
            setProfile(userProfile);
            setProfileRole(userProfile.role);
            setAuthStatus('ready');
            setScreen('dashboard');
          }
        } catch (error) {
          if (requestId !== authResolutionId.current) return;
          setAuthError(authFailureMessage(error, false, true));
          setAuthStatus('profile-error');
        }
      } else {
        setAuthError('Sign-in did not return an authenticated session. Please try again.');
      }
    } catch (error) {
      setAuthError(authFailureMessage(error, true));
    } finally {
      setAuthLoading(false);
    }
  }

  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    setAuthError('');
    try {
      const { error } = await getSupabaseClient().auth.signOut({ scope: 'local' });
      if (error) {
        setAuthError(authFailureMessage(error));
        return;
      }
      setScreen('dashboard');
      window.history.replaceState({}, '', '/');
    } catch (error) {
      setAuthError(authFailureMessage(error));
    } finally {
      setSigningOut(false);
    }
  }

  async function openLetter(id) {
    setCurrentLetterId(id);
    setDecisionComment('');
    if (profileRole !== 'student') return;

    const requestId = ++studentDetailRequestId.current;
    setStudentDetail(null);
    setStudentDetailError('');
    setStudentDetailStatus('loading');
    try {
      const detail = await getStudentLetterDetails({ studentId: authUser.id, letterId: id });
      if (requestId !== studentDetailRequestId.current) return;
      if (!detail) {
        setStudentDetailError('This letter could not be found or is no longer available.');
        setStudentDetailStatus('error');
        return;
      }
      setStudentDetail(detail);
      setStudentDetailStatus('ready');
    } catch (error) {
      if (requestId !== studentDetailRequestId.current) return;
      setStudentDetailError(studentDataFailureMessage(error));
      setStudentDetailStatus('error');
    }
  }

  function closeLetter() {
    studentDetailRequestId.current += 1;
    setCurrentLetterId(null);
    setStudentDetail(null);
    setStudentDetailError('');
    setStudentDetailStatus('idle');
  }

  function decideLetter(status) {
    if (profileRole !== 'dean' || !['Approved', 'Disapproved'].includes(status)) return;
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

  async function handleSubmitLetter(event) {
    event.preventDefault();
    if (profileRole !== 'student' || !authUser?.id || studentSubmitting) return;
    const form = event.currentTarget;
    const data = new FormData(event.currentTarget);
    const courseId = String(data.get('courseId') || '');
    const absenceStart = String(data.get('absenceStart') || '');
    const absenceEnd = String(data.get('absenceEnd') || '');
    const reason = String(data.get('reason') || '').trim();
    setStudentSubmitError('');

    if (!studentCourses.some((course) => course.id === courseId)) {
      setStudentSubmitError('Select a course in which you are enrolled.');
      return;
    }
    if (!absenceStart || !absenceEnd || !reason) {
      setStudentSubmitError('Complete the course, absence dates, and reason fields.');
      return;
    }
    if (absenceEnd < absenceStart) {
      setStudentSubmitError('The end date must be on or after the start date.');
      return;
    }
    if (studentCoursesStatus !== 'ready') {
      setStudentSubmitError('Your enrolled courses are not ready. Refresh them and try again.');
      return;
    }

    setStudentSubmitting(true);
    try {
      const createdLetter = await createStudentLetter({
        studentId: authUser.id,
        courseId,
        absenceStart,
        absenceEnd,
        reason,
        enrolledCourses: studentCourses,
      });
      setStudentLetters((current) => [createdLetter, ...current]);
      setStudentLettersStatus('ready');
      form.reset();
      navigate('letters');
      showToast('Your excuse letter was submitted for review.');
    } catch (error) {
      setStudentSubmitError(studentDataFailureMessage(error));
    } finally {
      setStudentSubmitting(false);
    }
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
  const dashboardLetters = profileRole === 'dean' ? sortedLetters.filter((letter) => letter.status === 'Pending') : sortedLetters;
  const matches = (letter, text, status) => (!text || `${letter.studentName} ${letter.studentNumber} ${letter.course} ${letter.professor}`.toLowerCase().includes(text.toLowerCase()))
    && (status === 'all' || letter.status.toLowerCase() === status.toLowerCase());
  const allLetters = sortedLetters.filter((letter) => matches(letter, search, filter));
  const historyLetters = sortedLetters.filter((letter) => matches(letter, historySearch, historyFilter));
  const pendingCount = profileRole === 'dean'
    ? letters.filter((letter) => letter.status === 'Pending').length
    : profileRole === 'professor' ? visibleLetters.length : visibleLetters.filter((letter) => letter.status === 'Pending').length;
  const activeLetter = profileRole === 'student'
    ? studentDetail && toStudentLetterView(studentDetail, profile, authUser)
    : letters.find((letter) => letter.id === currentLetterId);
  const studentDetailOpen = profileRole === 'student' && Boolean(currentLetterId);
  const modalOpen = studentDetailOpen || Boolean(activeLetter);

  if (authStatus === 'checking-session' || authStatus === 'loading-profile') {
    return <main className="auth-loading" role="status">{authStatus === 'loading-profile' ? 'Loading your account profile…' : 'Checking your sign-in session…'}</main>;
  }

  if (['error', 'profile-error', 'missing-profile', 'invalid-role', 'missing-configuration'].includes(authStatus)) {
    const recoveryMessage = {
      error: authError,
      'profile-error': authError,
      'missing-profile': 'Your signed-in account does not have a profile. Contact an administrator to provision your account.',
      'invalid-role': 'Your profile has an unsupported role. Access is blocked; contact an administrator.',
      'missing-configuration': 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then restart Vite.',
    }[authStatus];
    return (
      <section className="login-screen">
        <div className="login-aside">
          <div className="login-brand"><img src={logo} alt="University of the Assumption seal" /><div><div className="login-brand-name">University of the Assumption</div><div className="login-brand-sub">Student Affairs · San Fernando, Pampanga</div></div></div>
          <div className="login-message"><div className="eyebrow">Account access</div><h1>We could not verify your account.</h1><p>Your dashboard is unavailable until your account and profile can be verified.</p></div>
          <div className="login-footer">Academic year 2026-2027 · University of the Assumption</div>
        </div>
        <div className="login-panel"><div className="login-card">
          <h2>Account check</h2><p className="login-error" role="alert">{recoveryMessage}</p>
          {authStatus !== 'missing-configuration' && <button className="secondary auth-retry" type="button" onClick={() => { setAuthError(''); setAuthStatus('checking-session'); setAuthCheckVersion((version) => version + 1); }}>Retry</button>}
          {authUser && <button className="secondary auth-retry" type="button" onClick={logout} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>}
        </div></div>
      </section>
    );
  }

  if (!authUser) {
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
            <p>{isSupabaseConfigured
              ? 'Sign in with your university account.'
              : 'Sign-in is unavailable until Supabase is configured.'}</p>
            <div className="field"><label htmlFor="login-email">University email</label><input id="login-email" name="email" type="email" autoComplete="username" required disabled={!isSupabaseConfigured || authLoading} placeholder="name@udu.ph" /></div>
            <div className="field"><label htmlFor="login-password">Password</label><input id="login-password" name="password" type="password" autoComplete="current-password" required disabled={!isSupabaseConfigured || authLoading} placeholder="Enter your password" /></div>
            <button className="primary login-submit" type="submit" disabled={!isSupabaseConfigured || authLoading}>{authLoading ? 'Signing in…' : 'Sign in'}</button>
            {authError && <p className="login-error" role="alert">{authError}</p>}
          </form>
        </div>
      </section>
    );
  }

  const roleCopy = {
    student: ['Good morning, Mika.', 'Your excuse letters, all in one place.', 'Recent letters', 'A quick look at your latest submissions', 'Excuse letters', 'Your submissions and their current status.', 'My letters'],
    dean: ['Good morning, Dean.', 'Review requests and record decisions.', 'Needs your review', 'Pending requests are ready for a decision', 'Review letters', 'Review submissions and record a decision with an optional comment.', 'Review queue'],
    professor: ['Good morning, Professor.', 'Approved excuse letters for your classes.', 'Approved for your class', 'Approved requests assigned to you', 'Approved letters', 'Only Dean-approved letters assigned to your classes appear here.', 'Approved letters'],
  }[profileRole];
  const statuses = ['all', 'Pending', 'Approved', 'Disapproved'];

  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand"><img className="brand-mark" src={logo} alt="University of the Assumption seal" /><div><div className="brand-name">University of the<br />Assumption</div><div className="brand-sub">Pampanga · Student Affairs</div></div></div>
          <div className="side-label">Workspace</div>
          <nav className="nav" aria-label="Main navigation">
            {[['dashboard', 'OV', 'Overview'], ['letters', 'EL', roleCopy[6]], ...(profileRole !== 'professor' ? [['history', 'HI', 'Letter history']] : [])].map(([key, icon, label]) => (
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
            <div className="top-actions"><div className="user-chip"><div className="avatar">{displayInitials}</div><div><div className="user-name">{displayName}</div><div className="user-role">{profileRole} profile</div></div></div><button className="secondary" onClick={logout} disabled={signingOut} type="button">{signingOut ? 'Signing out…' : 'Sign out'}</button></div>
          </header>
          {authError && <p className="login-error auth-notice" role="alert">{authError}</p>}
          <div className="content">
            {screen === 'dashboard' && (
              <section className="screen active">
                <div className="page-heading"><div><div className="eyebrow">University of the Assumption · San Fernando, Pampanga</div><h1>{roleCopy[0].replace('Mika', displayName.split(/\s+/)[0])}</h1><p className="subtitle">{roleCopy[1]}</p></div>{profileRole === 'student' && <button className="primary" onClick={() => navigate('submit')} type="button">+ &nbsp; New excuse letter</button>}</div>
                <div className="stats">
                  {[
                    ['Total letters', profileRole === 'student' && studentLettersStatus === 'loading' ? '…' : profileRole === 'student' && studentLettersStatus === 'error' ? '—' : visibleLetters.length, 'Across your records', 'EL'],
                    ['Awaiting review', profileRole === 'student' && studentLettersStatus === 'loading' ? '…' : profileRole === 'student' && studentLettersStatus === 'error' ? '—' : visibleLetters.filter((item) => item.status === 'Pending').length, 'In the Dean’s queue', '…'],
                    ['Approved', profileRole === 'student' && studentLettersStatus === 'loading' ? '…' : profileRole === 'student' && studentLettersStatus === 'error' ? '—' : visibleLetters.filter((item) => item.status === 'Approved').length, 'Ready to view', 'OK'],
                    ['Disapproved', profileRole === 'student' && studentLettersStatus === 'loading' ? '…' : profileRole === 'student' && studentLettersStatus === 'error' ? '—' : visibleLetters.filter((item) => item.status === 'Disapproved').length, 'See Dean comments', 'NO'],
                  ].map(([label, value, note, mark]) => <div className="stat" key={label}><div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></div><div className="stat-mark">{mark}</div></div>)}
                </div>
                <div className="workspace">
                  <section className="panel"><div className="panel-head"><div><div className="panel-title">{roleCopy[2]}</div><div className="panel-kicker">{roleCopy[3]}</div></div><div className="table-tools">{profileRole === 'student' && <button className="secondary" onClick={() => setStudentRefreshVersion((version) => version + 1)} type="button" disabled={studentLettersStatus === 'loading'}>Refresh</button>}{profileRole !== 'professor' && <button className="secondary" onClick={() => navigate('history')} type="button">View history</button>}</div></div>
                    <LetterTable
                      items={dashboardLetters.slice(0, 5)}
                      mode={profileRole === 'student' ? 'student' : 'recent'}
                      profileRole={profileRole}
                      onOpen={openLetter}
                      emptyText={profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your letters…' : profileRole === 'student' && studentLettersStatus === 'error' ? studentLettersError : profileRole === 'student' ? 'No excuse letters submitted yet.' : 'Nothing here yet. New letters will appear as they are submitted.'}
                    />
                  </section>
                  <aside className="right-col">
                    <section className="notice"><div className="notice-title">Paperwork, without the paper.</div><p>Submit an excuse letter once. Student Affairs reviews it, and your professor can see it as soon as it is approved.</p>{profileRole === 'student' && <button className="secondary" onClick={() => navigate('submit')} type="button">Start a letter &nbsp; →</button>}</section>
                    <section className="panel"><div className="panel-head"><div><div className="panel-title">Latest activity</div><div className="panel-kicker">Updates from the letter desk</div></div></div><Activity items={visibleLetters} notifications={notifications} profileRole={profileRole} email={authUser.email} displayName={displayName} loading={studentLettersStatus === 'loading'} error={profileRole === 'student' ? studentLettersError : ''} /></section>
                    {profileRole === 'dean' && <section className="panel assignment-panel"><div className="panel-head"><div><div className="panel-title">Professor assignments</div><div className="panel-kicker">Manage professor-to-course pairing</div></div></div>
                      <div className="assignment-list">{assignments.map((item) => <div className="assignment-item" key={`${item.professor}-${item.course}`}><div><strong>{item.professor}</strong><small>{item.course}</small></div><span className="status approved">Assigned</span></div>)}</div>
                      <div className="assignment-form"><div className="row"><div className="field"><label htmlFor="assignment-professor">Professor</label><select id="assignment-professor" value={assignmentProfessor} onChange={(event) => setAssignmentProfessor(event.target.value)}>{professors.map((name) => <option key={name}>{name}</option>)}</select></div><div className="field"><label htmlFor="assignment-course">Course</label><select id="assignment-course" value={assignmentCourse} onChange={(event) => setAssignmentCourse(event.target.value)}>{courses.map((course) => <option key={course}>{course}</option>)}</select></div></div><button className="primary" onClick={saveAssignment} type="button">Assign professor</button></div>
                    </section>}
                  </aside>
                </div>
              </section>
            )}
            {screen === 'letters' && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Excuse letter desk</div><h1>{roleCopy[4]}</h1><p className="subtitle">{roleCopy[5]}</p></div>{profileRole === 'student' && <button className="primary" onClick={() => navigate('submit')} type="button">+ &nbsp; New excuse letter</button>}</div>
              <section className="panel"><div className="panel-head"><div><div className="panel-title">All letters</div><div className="panel-kicker">{profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your records…' : `${sortedLetters.length} letter${sortedLetters.length === 1 ? '' : 's'} in this view`}</div></div><div className="table-tools">{profileRole === 'student' && <button className="secondary" onClick={() => setStudentRefreshVersion((version) => version + 1)} type="button" disabled={studentLettersStatus === 'loading'}>Refresh</button>}<input className="search" type="search" placeholder="Search names or course" aria-label="Search letters" value={search} onChange={(event) => setSearch(event.target.value)} /><select className="filter" aria-label="Filter by status" value={filter} onChange={(event) => setFilter(event.target.value)}>{statuses.map((status) => <option key={status} value={status}>{status === 'all' ? 'All statuses' : status}</option>)}</select></div></div>
                {profileRole === 'student' && studentLettersError && <p className="student-data-error" role="alert">{studentLettersError}</p>}
                <LetterTable items={allLetters} mode={profileRole === 'student' ? 'student' : 'all'} profileRole={profileRole} onOpen={openLetter} emptyText={profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your letters…' : profileRole === 'student' && studentLettersStatus === 'error' ? studentLettersError : profileRole === 'student' ? 'No excuse letters match this view.' : 'No letters match this view.'} />
              </section>
            </section>}
            {screen === 'history' && profileRole !== 'professor' && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Records & decisions</div><h1>Letter history</h1><p className="subtitle">A record of your submissions and any recorded status changes.</p></div></div>
              <section className="panel"><div className="panel-head"><div><div className="panel-title">Complete record</div><div className="panel-kicker">{profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your records…' : `${sortedLetters.length} complete record${sortedLetters.length === 1 ? '' : 's'}`}</div></div><div className="table-tools">{profileRole === 'student' && <button className="secondary" onClick={() => setStudentRefreshVersion((version) => version + 1)} type="button" disabled={studentLettersStatus === 'loading'}>Refresh</button>}<input className="search" type="search" placeholder="Search history" aria-label="Search history" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} /><select className="filter" aria-label="Filter history by status" value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)}>{statuses.map((status) => <option key={status} value={status}>{status === 'all' ? 'All statuses' : status}</option>)}</select></div></div>
                {profileRole === 'student' && studentLettersError && <p className="student-data-error" role="alert">{studentLettersError}</p>}
                <LetterTable items={historyLetters} mode={profileRole === 'student' ? 'student' : 'history'} profileRole={profileRole} onOpen={openLetter} emptyText={profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your letters…' : profileRole === 'student' && studentLettersStatus === 'error' ? studentLettersError : 'No letters to show yet.'} />
              </section>
            </section>}
            {screen === 'submit' && profileRole === 'student' && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Student services · New request</div><h1>Submit an excuse letter</h1><p className="subtitle">Choose an enrolled course and enter the dates and reason for your absence.</p></div></div>
              <div className="letter-layout">
                <form className="panel form-panel" onSubmit={handleSubmitLetter}>
                  <div className="form-section"><h2 className="section-title">Student account</h2><p className="form-account">{profile?.full_name || authUser.email}{profile?.student_number ? ` · ${profile.student_number}` : ''}</p><p className="field-hint">Your signed-in account is used as the owner of this request.</p></div>
                  <div className="form-section"><h2 className="section-title">Class and absence</h2><div className="form-grid">
                    <div className="field full"><label htmlFor="course-id">Enrolled course / class *</label><select id="course-id" name="courseId" required disabled={studentCoursesStatus !== 'ready' || studentCourses.length === 0 || studentSubmitting} defaultValue=""><option value="" disabled>{studentCoursesStatus === 'loading' ? 'Loading your enrolled courses…' : studentCoursesStatus === 'error' ? 'Courses could not be loaded' : studentCourses.length === 0 ? 'No enrolled courses found' : 'Choose an enrolled course'}</option>{studentCourses.map((course) => <option key={course.id} value={course.id}>{course.course_code} · {course.course_name}{course.section ? ` (${course.section})` : ''}</option>)}</select></div>
                    {studentCoursesStatus === 'error' && <div className="field full"><p className="student-data-error" role="alert">{studentCoursesError}</p><button className="secondary" type="button" onClick={() => setStudentRefreshVersion((version) => version + 1)}>Retry course loading</button></div>}
                    {studentCoursesStatus === 'ready' && studentCourses.length === 0 && <p className="field-hint full">No courses are currently linked to your account. Contact Student Affairs if you believe this is incorrect.</p>}
                    <div className="field"><label htmlFor="absence-start">Absence from *</label><input id="absence-start" name="absenceStart" type="date" required disabled={studentSubmitting} /></div>
                    <div className="field"><label htmlFor="absence-end">Absence to *</label><input id="absence-end" name="absenceEnd" type="date" required disabled={studentSubmitting} /></div>
                    <div className="field full"><label htmlFor="reason">Reason for absence *</label><textarea id="reason" name="reason" required maxLength={4000} placeholder="Briefly explain the reason for your absence" disabled={studentSubmitting} /></div>
                  </div></div>
                  <p className="field-hint">Evidence uploads are not available in this phase.</p>
                  {studentSubmitError && <p className="student-data-error" role="alert">{studentSubmitError}</p>}
                  <div className="form-actions"><button type="button" className="secondary" onClick={() => navigate('dashboard')} disabled={studentSubmitting}>Cancel</button><button className="primary" type="submit" disabled={studentSubmitting || studentCoursesStatus !== 'ready' || studentCourses.length === 0}>{studentSubmitting ? 'Submitting…' : 'Submit excuse letter'}</button></div>
                </form>
                <aside className="panel side-note"><h3>What happens next</h3><p>Your request is saved with a pending status. You can check its current status and any later updates from your letter list.</p><div className="steps"><div className="step"><div className="step-number">1</div><div><strong>Submit your request</strong>Your account, enrolled course, absence dates, and reason are recorded.</div></div><div className="step"><div className="step-number">2</div><div><strong>Await review</strong>The request remains pending until it is reviewed in a later phase.</div></div><div className="step"><div className="step-number">3</div><div><strong>Check your records</strong>Open the letter to review its status history.</div></div></div></aside>
              </div>
            </section>}
          </div>
        </main>
      </div>
      <div className={`modal-backdrop${modalOpen ? ' open' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={(event) => { if (event.target === event.currentTarget) closeLetter(); }}>
        {modalOpen && <div className="modal">
          {studentDetailOpen ? (
            <>
              <div className="modal-head"><div><h2 id="modal-title">Excuse letter</h2><p>{activeLetter ? `${activeLetter.id} · Submitted ${formatDate(activeLetter.submitted)}` : 'Student record'}</p></div><button className="close" onClick={closeLetter} aria-label="Close" type="button">×</button></div>
              <div className="modal-content">
                {studentDetailStatus === 'loading' && <p className="student-detail-message" role="status">Loading letter details…</p>}
                {studentDetailStatus === 'error' && <p className="student-data-error" role="alert">{studentDetailError}</p>}
                {activeLetter && <div className="detail-grid">
                  <div><div className="detail-label">Status</div><div className="detail-value"><Status value={activeLetter.status} /></div></div>
                  <Detail label="Course" value={activeLetter.course} />
                  <Detail label="Absence dates" value={dateRange(activeLetter)} />
                  <Detail label="Submitted" value={formatDateTime(activeLetter.submitted)} />
                  <div className="detail-full"><div className="detail-label">Reason</div><div className="detail-value">{activeLetter.reason}</div></div>
                </div>}
                {activeLetter?.comment && <div className="comment-box"><strong>Dean’s comment</strong><br />{activeLetter.comment}</div>}
                {activeLetter && <section className="status-history"><h3>Status history</h3>{studentDetail.statusEvents.length
                  ? <ol>{studentDetail.statusEvents.map((event) => <li key={event.id}><strong>{event.old_status} → {event.new_status}</strong><time>{formatDateTime(event.created_at)}</time>{event.comment && <p>{event.comment}</p>}</li>)}</ol>
                  : <p>No status changes have been recorded yet. A history entry is created when the status changes.</p>}</section>}
              </div>
              <div className="modal-actions"><button className="secondary" onClick={closeLetter} type="button">Close</button><span className="modal-hint">Status changes are not available in this phase.</span></div>
            </>
          ) : activeLetter && (
            <>
              <div className="modal-head"><div><h2 id="modal-title">{activeLetter.studentName}</h2><p>{activeLetter.id} · Submitted {formatDate(activeLetter.submitted)}</p></div><button className="close" onClick={closeLetter} aria-label="Close" type="button">×</button></div>
              <div className="modal-content"><div className="detail-grid">
                <Detail label="Student number" value={activeLetter.studentNumber} /><Detail label="Program / year" value={activeLetter.program} /><Detail label="School email" value={activeLetter.email} /><Detail label="Parent / guardian" value={activeLetter.parentContact || 'Not provided'} />
                <div><div className="detail-label">Status</div><div className="detail-value"><Status value={activeLetter.status} /></div></div><Detail label="Course" value={activeLetter.course} /><Detail label="Assigned professor" value={activeLetter.professor} /><Detail label="Absence dates" value={dateRange(activeLetter)} />
                <div><div className="detail-label">Evidence</div><div className="detail-value"><div className="review-evidence">{(activeLetter.evidence || []).length ? activeLetter.evidence.map((item, index) => { const evidence = typeof item === 'string' ? { name: item } : item; return <Evidence key={`${evidence.name}-${index}`} item={evidence} />; }) : <span>No evidence attached</span>}</div></div></div>
                <div className="detail-full"><div className="detail-label">Reason</div><div className="detail-value">{activeLetter.reason}</div></div>
              </div>
              {activeLetter.comment && <div className="comment-box"><strong>Dean’s comment</strong><br />{activeLetter.comment}</div>}
              <div className="qr-center"><QRCode letter={activeLetter} /></div>
              </div>
              <div className="modal-actions">{profileRole === 'dean' && activeLetter.status === 'Pending' ? <><div className="comment-field"><textarea aria-label="Optional comment for the student" placeholder="Optional comment for the student" value={decisionComment} onChange={(event) => setDecisionComment(event.target.value)} /></div><div className="action-right"><button className="danger" onClick={() => decideLetter('Disapproved')} type="button">Disapprove</button><button className="approve" onClick={() => decideLetter('Approved')} type="button">Approve</button></div></> : <><button className="secondary" onClick={closeLetter} type="button">Close</button><span className="modal-hint">{activeLetter.status === 'Approved' ? 'Visible to assigned professor' : activeLetter.status === 'Pending' ? 'Awaiting Dean review' : 'See the comment above for next steps'}</span></>}</div>
            </>
          )}
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

function Activity({ items, notifications, profileRole, email, displayName, loading = false, error = '' }) {
  if (profileRole === 'student' && loading) return <div className="empty-state" role="status">Loading your activity…</div>;
  if (profileRole === 'student' && error) return <div className="empty-state student-data-error" role="alert">{error}</div>;
  if (profileRole === 'professor' || profileRole === 'dean') {
    const list = profileRole === 'professor'
      ? notifications.filter((item) => item.email === email || item.user === displayName).slice(0, 4)
      : notifications.slice(0, 3);
    return list.length ? <div className="notification-list">{list.map((item) => <div className="notification-item" key={item.id}><strong>{item.message}</strong><small>{profileRole === 'dean' ? item.user : item.email || 'Email not set'} · {formatDate(item.createdAt)}</small></div>)}</div> : <div className="empty-state">No notifications yet.</div>;
  }
  const recent = [...items].sort((a, b) => b.submitted.localeCompare(a.submitted)).slice(0, 3);
  return recent.length ? <div className="activity">{recent.map((letter) => <div className="activity-item" key={letter.id}><div className="activity-dot">{letter.status === 'Approved' ? '✓' : letter.status === 'Pending' ? '…' : '!'}</div><div><div className="activity-text"><strong>{letter.id}</strong> · {letter.studentName}<br />{letter.status}{letter.comment ? `: ${letter.comment}` : ''}</div><div className="activity-time">Submitted {formatDate(letter.submitted)}</div></div></div>)}</div> : <div className="empty-state">No recent activity.</div>;
}
