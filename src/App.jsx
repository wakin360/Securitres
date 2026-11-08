import React, { useEffect, useRef, useState } from 'react';
import logo from '../ua-logo.png';
import { getSupabaseClient, isSupabaseConfigured } from './lib/supabase.js';
import { getProfileForUser, profileRoles } from './services/profile.js';
import {
  StudentLetterSubmissionError,
  createStudentLetterWithEvidence,
  getStudentCourses,
  getStudentLetterDetails,
  getStudentLetters,
} from './services/studentLetters.js';
import {
  EvidenceUploadError,
  getStudentEvidence,
  getStudentEvidenceSignedUrl,
  uploadStudentEvidence,
  validateEvidenceFile,
} from './services/studentEvidence.js';
import {
  getDeanEvidenceSignedUrl,
  getDeanLetters,
  getDeanLetterDetails,
  submitDeanDecision,
} from './services/deanReview.js';
import {
  getStudentDecisionNotification,
  sendStudentDecisionNotification,
} from './services/studentDecisionNotifications.js';
import {
  getProfessorCourses,
  getProfessorEvidence,
  getProfessorEvidenceSignedUrl,
  getProfessorLetterDetails,
  getProfessorLetterStudentIdentity,
  getProfessorLetters,
} from './services/professorLetters.js';
import {
  getProfessorIdentityStatesForAccount,
  updateProfessorIdentityState,
} from './utils/professorIdentityState.js';
import { ProfessorIdentityCell } from './components/ProfessorIdentityCell.js';

const STORAGE_KEYS = {
  letters: 'ua-excuse-letters-v1',
  notifications: 'ua-notifications-v1',
};

const studentProgramMissingMessage = 'Your academic program is not assigned yet. Contact Student Affairs to complete your account setup.';

const seedLetters = [
  { id: 'UA-2026-0418', studentName: 'Mika Santos', studentNumber: '2024-01842', program: 'BS Information Technology, 2nd year', email: 'mika.santos@ua.edu', course: 'Data Structures', professor: 'Prof. Elena Cruz', parentContact: '0917-123-4567', dateFrom: '2026-10-15', dateTo: '2026-10-15', reason: 'I was unable to attend class due to a medical consultation.', evidence: ['clinic-visit.pdf'], submitted: '2026-10-16', status: 'Pending', comment: '' },
  { id: 'UA-2026-0412', studentName: 'Jonah Reyes', studentNumber: '2023-00719', program: 'BS Accountancy, 3rd year', email: 'jonah.reyes@ua.edu', course: 'Cost Accounting', professor: 'Prof. Mark Anthony Santos', parentContact: '0922-654-1122', dateFrom: '2026-10-12', dateTo: '2026-10-12', reason: 'Family emergency required me to travel home.', evidence: ['supporting-note.jpg'], submitted: '2026-10-13', status: 'Approved', comment: 'Approved. Please coordinate any missed assessment with your professor.' },
  { id: 'UA-2026-0398', studentName: 'Aira Villanueva', studentNumber: '2025-02103', program: 'BS Psychology, 1st year', email: 'aira.v@ua.edu', course: 'General Psychology', professor: 'Prof. Jenny Flores', parentContact: '0933-889-1020', dateFrom: '2026-10-08', dateTo: '2026-10-09', reason: 'I was recovering from a fever and was advised to rest.', evidence: ['medical-certificate.pdf'], submitted: '2026-10-10', status: 'Disapproved', comment: 'Please attach a readable copy of the supporting document and resubmit.' },
  { id: 'UA-2026-0381', studentName: 'Mika Santos', studentNumber: '2024-01842', program: 'BS Information Technology, 2nd year', email: 'mika.santos@ua.edu', course: 'Discrete Mathematics', professor: 'Prof. Elena Cruz', parentContact: '0917-123-4567', dateFrom: '2026-10-02', dateTo: '2026-10-02', reason: 'I had a scheduled medical appointment.', evidence: ['appointment-slip.png'], submitted: '2026-10-03', status: 'Approved', comment: 'Approved. Thank you for providing supporting evidence.' },
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

function getLetterDeepLink(letterId) {
  const url = new URL(window.location.href);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  url.searchParams.set('letter', letterId);
  return url.toString();
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

function toDeanLetterView(letter) {
  const course = letter.course;
  const student = letter.student;
  const professor = course?.professor;
  return {
    id: letter.id,
    studentName: student?.full_name || 'Student profile unavailable',
    studentNumber: student?.student_number || 'Not provided',
    program: student?.program || 'Not provided',
    course: course
      ? `${course.course_code} · ${course.course_name}${course.section ? ` (${course.section})` : ''}`
      : 'Course unavailable',
    professor: professor?.full_name || 'Not assigned',
    dateFrom: letter.absence_start,
    dateTo: letter.absence_end,
    reason: letter.reason,
    submitted: letter.submitted_at,
    status: letter.status.charAt(0).toUpperCase() + letter.status.slice(1),
    comment: letter.dean_comment || '',
  };
}

function toProfessorLetterView(letter) {
  const course = letter.course;
  return {
    id: letter.id,
    courseId: letter.course_id,
    course: course
      ? `${course.course_code} · ${course.course_name}${course.section ? ` (${course.section})` : ''}`
      : 'Course unavailable',
    dateFrom: letter.absence_start,
    dateTo: letter.absence_end,
    reason: letter.reason,
    submitted: letter.submitted_at,
    status: 'Approved',
    approvedAt: letter.decided_at,
  };
}

function studentDataFailureMessage(error) {
  if (import.meta.env.DEV) console.error('Student excuse-letter request failed.', error);
  if (error instanceof StudentLetterSubmissionError) return error.message;
  if (error instanceof EvidenceUploadError) return error.message;
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

function professorDataFailureMessage(error) {
  if (import.meta.env.DEV) console.error('Professor letter request failed.', error);
  if (error?.code === '42501' || error?.code === 'PGRST301') {
    return 'You do not have permission to access these Professor records. Refresh your session or contact support.';
  }
  if (error instanceof TypeError || error?.name === 'AuthRetryableFetchError') {
    return 'Could not reach the Professor services database. Check your connection and try again.';
  }
  return 'Could not load Professor records. Please try again.';
}

function reviewDataFailureMessage(error) {
  if (import.meta.env.DEV) console.error('Dean review request failed.', error);
  if (error?.code === '42501' || error?.code === 'PGRST301') {
    return 'You do not have permission to review this letter. Refresh your session or contact support.';
  }
  if (error?.code === 'P0001') {
    return 'This letter has already been decided or is no longer available for review. Refresh the pending queue.';
  }
  if (error instanceof TypeError || error?.name === 'AuthRetryableFetchError') {
    return 'Could not reach the review service. Check your connection and try again.';
  }
  return 'Could not load or save this review. Please try again.';
}

function initials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function Status({ value }) {
  const statusClass = value.toLowerCase() === 'rejected' ? 'disapproved' : value.toLowerCase();
  return <span className={`status ${statusClass}`}>{value}</span>;
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

function LetterTable({ items, mode, profileRole, onOpen, emptyText, professorIdentities = {}, onRetryProfessorIdentity, tableClass = '' }) {
  if (!items.length) return <div className="empty-state">{emptyText}</div>;
  if (mode === 'student') {
    return (
      <div className={`table-wrap${tableClass ? ` ${tableClass}-wrap` : ''}`}>
        <table className={tableClass}>
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
  if (mode === 'professor') {
    return (
      <div className="table-wrap professor-table-wrap">
        <table className="professor-letters-table">
          <thead><tr><th>Student Name</th><th>Student Number</th><th>Course / section</th><th>Absence dates</th><th>Approved</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.map((letter) => (
              <tr key={letter.id}>
                <td className="professor-identity-cell"><ProfessorIdentityCell identityState={professorIdentities[letter.id]} field="full_name" letterId={letter.id} onRetry={onRetryProfessorIdentity} /></td>
                <td className="professor-identity-cell"><ProfessorIdentityCell identityState={professorIdentities[letter.id]} field="student_number" letterId={letter.id} onRetry={onRetryProfessorIdentity} /></td>
                <td className="professor-course-cell">{letter.course}</td>
                <td>{dateRange(letter)}</td>
                <td>{formatDate(letter.approvedAt)}</td>
                <td><Status value="Approved" /></td>
                <td><button className="review-link" type="button" onClick={() => onOpen(letter.id)}>Details</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (mode === 'history') {
    return (
      <div className="table-wrap">
        <table>
          <thead><tr><th>Student</th><th>Course / section</th><th>Reason</th><th>Submitted</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.map((letter) => (
              <tr key={letter.id}>
                <td><StudentCell letter={letter} /></td>
                <td>{letter.course}</td>
                <td className="student-reason">{letter.reason}</td>
                <td>{formatDate(letter.submitted)}</td>
                <td><Status value={letter.status === 'Disapproved' ? 'Rejected' : letter.status} /></td>
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

function QRCode({ letterId }) {
  const [dataUrl, setDataUrl] = useState('');
  const [generationError, setGenerationError] = useState('');
  const letterUrl = getLetterDeepLink(letterId);

  useEffect(() => {
    let active = true;
    setDataUrl('');
    setGenerationError('');
    import('qrcode').then(({ default: QRCodeGenerator }) => QRCodeGenerator.toDataURL(letterUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
      color: { dark: '#08285f', light: '#ffffff' },
    })).then((result) => {
      if (active) setDataUrl(result);
    }).catch((error) => {
      if (!active) return;
      console.error('Could not generate the letter QR code.', error);
      setGenerationError('The QR code could not be generated. Use the secure link below instead.');
    });
    return () => { active = false; };
  }, [letterUrl]);

  return (
    <div className="qr-box">
      <div className="detail-label">Open this exact letter</div>
      {dataUrl ? (
        <img className="qr-image" src={dataUrl} alt={`QR code to open excuse letter ${letterId}`} />
      ) : null}
      {generationError && <p className="qr-error" role="alert">{generationError}</p>}
      <a className="qr-link" href={letterUrl}>Open letter {letterId}</a>
      <span className="qr-note">Sign in to Securitres; normal letter-access permissions apply.</span>
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
  const [studentSubmissionNotice, setStudentSubmissionNotice] = useState('');
  const [studentSubmissionFiles, setStudentSubmissionFiles] = useState([]);
  const [studentSubmissionFileError, setStudentSubmissionFileError] = useState('');
  const [studentSubmitProgress, setStudentSubmitProgress] = useState('');
  const [studentDetail, setStudentDetail] = useState(null);
  const [studentDetailStatus, setStudentDetailStatus] = useState('idle');
  const [studentDetailError, setStudentDetailError] = useState('');
  const [studentEvidence, setStudentEvidence] = useState([]);
  const [studentEvidenceStatus, setStudentEvidenceStatus] = useState('idle');
  const [studentEvidenceError, setStudentEvidenceError] = useState('');
  const [studentEvidenceFile, setStudentEvidenceFile] = useState(null);
  const [studentEvidenceFileError, setStudentEvidenceFileError] = useState('');
  const [studentEvidenceUploading, setStudentEvidenceUploading] = useState(false);
  const [studentEvidenceSuccess, setStudentEvidenceSuccess] = useState('');
  const [studentEvidenceLinks, setStudentEvidenceLinks] = useState({});
  const [studentEvidenceLinkLoading, setStudentEvidenceLinkLoading] = useState('');
  const [deanLetters, setDeanLetters] = useState([]);
  const [deanLettersStatus, setDeanLettersStatus] = useState('idle');
  const [deanLettersError, setDeanLettersError] = useState('');
  const [deanRefreshVersion, setDeanRefreshVersion] = useState(0);
  const [deanDetail, setDeanDetail] = useState(null);
  const [deanDetailStatus, setDeanDetailStatus] = useState('idle');
  const [deanDetailError, setDeanDetailError] = useState('');
  const [deanEvidenceLinks, setDeanEvidenceLinks] = useState({});
  const [deanEvidenceLinkLoading, setDeanEvidenceLinkLoading] = useState('');
  const [deanDecisionBusy, setDeanDecisionBusy] = useState(false);
  const [deanDecisionError, setDeanDecisionError] = useState('');
  const [deanDecisionSuccess, setDeanDecisionSuccess] = useState('');
  const [deanNotificationStates, setDeanNotificationStates] = useState({});
  const [professorCourses, setProfessorCourses] = useState([]);
  const [professorCoursesStatus, setProfessorCoursesStatus] = useState('idle');
  const [professorCoursesError, setProfessorCoursesError] = useState('');
  const [professorLetters, setProfessorLetters] = useState([]);
  const [professorLettersStatus, setProfessorLettersStatus] = useState('idle');
  const [professorLettersError, setProfessorLettersError] = useState('');
  const [professorRefreshVersion, setProfessorRefreshVersion] = useState(0);
  const [professorTableIdentities, setProfessorTableIdentities] = useState({ accountId: null, byLetterId: {} });
  const [professorCourseFilter, setProfessorCourseFilter] = useState('all');
  const [professorDateFromFilter, setProfessorDateFromFilter] = useState('');
  const [professorDateToFilter, setProfessorDateToFilter] = useState('');
  const [professorDetail, setProfessorDetail] = useState(null);
  const [professorDetailStatus, setProfessorDetailStatus] = useState('idle');
  const [professorDetailError, setProfessorDetailError] = useState('');
  const [professorStudentIdentity, setProfessorStudentIdentity] = useState(null);
  const [professorStudentIdentityStatus, setProfessorStudentIdentityStatus] = useState('idle');
  const [professorStudentIdentityError, setProfessorStudentIdentityError] = useState('');
  const [professorEvidence, setProfessorEvidence] = useState([]);
  const [professorEvidenceStatus, setProfessorEvidenceStatus] = useState('idle');
  const [professorEvidenceError, setProfessorEvidenceError] = useState('');
  const [professorEvidenceLinks, setProfessorEvidenceLinks] = useState({});
  const [professorEvidenceLinkLoading, setProfessorEvidenceLinkLoading] = useState('');
  const [professorEvidenceLinkError, setProfessorEvidenceLinkError] = useState('');
  const [authStatus, setAuthStatus] = useState('checking-session');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authCheckVersion, setAuthCheckVersion] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [letters, setLetters] = useState(() => readStored(STORAGE_KEYS.letters, seedLetters));
  const [notifications] = useState(() => readStored(STORAGE_KEYS.notifications, seedNotifications));
  const [screen, setScreen] = useState('dashboard');
  const [currentLetterId, setCurrentLetterId] = useState(null);
  const [decisionComment, setDecisionComment] = useState('');
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [historySearch, setHistorySearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const toastTimer = useRef(null);
  const authResolutionId = useRef(0);
  const studentDetailRequestId = useRef(0);
  const studentEvidenceRequestId = useRef(0);
  const deanDetailRequestId = useRef(0);
  const deanEvidenceRequestId = useRef(0);
  const professorDetailRequestId = useRef(0);
  const professorIdentityRequestId = useRef(0);
  const professorTableIdentityRequestIds = useRef({});
  const professorTableIdentityAccountId = useRef(null);
  const professorEvidenceRequestId = useRef(0);
  const professorEvidenceLinkRequestId = useRef(0);
  const handledDeepLinkId = useRef('');
  const displayName = profile?.full_name || authUser?.email || 'University user';
  const displayInitials = initials(displayName);
  const visibleLetters = profileRole === 'student'
    ? studentLetters.map((letter) => toStudentLetterView(letter, profile, authUser))
    : profileRole === 'dean'
      ? deanLetters.map(toDeanLetterView)
      : profileRole === 'professor'
      ? professorLetters.map(toProfessorLetterView)
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

  useEffect(() => {
    let active = true;
    if (profileRole !== 'dean') {
      setDeanLetters([]);
      setDeanLettersStatus('idle');
      setDeanLettersError('');
      return () => { active = false; };
    }

    setDeanLettersStatus('loading');
    setDeanLettersError('');
    getDeanLetters()
      .then((lettersForDean) => {
        if (!active) return;
        setDeanLetters(lettersForDean);
        setDeanLettersStatus('ready');
      })
      .catch((error) => {
        if (!active) return;
        setDeanLetters([]);
        setDeanLettersError(reviewDataFailureMessage(error));
        setDeanLettersStatus('error');
      });

    return () => { active = false; };
  }, [profileRole, deanRefreshVersion]);

  useEffect(() => {
    let active = true;
    if (profileRole !== 'professor' || !authUser?.id) {
      professorTableIdentityAccountId.current = null;
      setProfessorCourses([]);
      setProfessorCoursesStatus('idle');
      setProfessorCoursesError('');
      setProfessorLetters([]);
      setProfessorLettersStatus('idle');
      setProfessorLettersError('');
      setProfessorTableIdentities({ accountId: null, byLetterId: {} });
      Object.keys(professorTableIdentityRequestIds.current).forEach((letterId) => {
        professorTableIdentityRequestIds.current[letterId] += 1;
      });
      setProfessorDetail(null);
      setProfessorDetailStatus('idle');
      setProfessorEvidence([]);
      setProfessorEvidenceStatus('idle');
      setProfessorEvidenceLinks({});
      return () => { active = false; };
    }

    professorTableIdentityAccountId.current = authUser.id;
    setProfessorCourses([]);
    setProfessorCoursesStatus('loading');
    setProfessorCoursesError('');
    setProfessorLetters([]);
    setProfessorLettersStatus('idle');
    setProfessorLettersError('');
    setProfessorTableIdentities({ accountId: authUser.id, byLetterId: {} });
    Object.keys(professorTableIdentityRequestIds.current).forEach((letterId) => {
      professorTableIdentityRequestIds.current[letterId] += 1;
    });

    getProfessorCourses()
      .then((courses) => {
        if (!active) return;
        setProfessorCourses(courses);
        setProfessorCoursesStatus('ready');
        if (courses.length === 0) {
          setProfessorLetters([]);
          setProfessorLettersStatus('ready');
          return;
        }

        setProfessorLettersStatus('loading');
        return getProfessorLetters()
          .then((lettersForProfessor) => {
            if (!active) return;
            setProfessorLetters(lettersForProfessor);
            setProfessorLettersStatus('ready');
          })
          .catch((error) => {
            if (!active) return;
            setProfessorLetters([]);
            setProfessorLettersError(professorDataFailureMessage(error));
            setProfessorLettersStatus('error');
          });
      })
      .catch((error) => {
        if (!active) return;
        setProfessorCourses([]);
        setProfessorCoursesError(professorDataFailureMessage(error));
        setProfessorCoursesStatus('error');
      });

    return () => { active = false; };
  }, [authUser?.id, profileRole, professorRefreshVersion]);

  useEffect(() => {
    let active = true;
    const accountId = profileRole === 'professor' ? authUser?.id || null : null;
    professorTableIdentityAccountId.current = accountId;

    if (!accountId || professorLettersStatus !== 'ready') {
      setProfessorTableIdentities({ accountId, byLetterId: {} });
      return () => { active = false; };
    }

    setProfessorTableIdentities({
      accountId,
      byLetterId: Object.fromEntries(professorLetters.map((letter) => [
        letter.id,
        { status: 'loading', identity: null },
      ])),
    });
    professorLetters.forEach((letter) => {
      void requestProfessorTableIdentity(letter.id, accountId, () => active);
    });

    return () => { active = false; };
  }, [authUser?.id, profileRole, professorLetters, professorLettersStatus]);

  useEffect(() => {
    if (profileRole === 'dean' && deanLettersStatus !== 'ready') return;
    if (profileRole === 'student' && studentLettersStatus !== 'ready') return;
    if (profileRole !== 'dean' && profileRole !== 'student') return;
    const url = new URL(window.location.href);
    const letterId = url.searchParams.get('letter');
    if (!letterId || handledDeepLinkId.current === letterId) return;

    handledDeepLinkId.current = letterId;
    url.searchParams.delete('letter');
    window.history.replaceState({}, '', url);

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(letterId)) {
      if (profileRole === 'dean') {
        setDeanDetailError('The letter link is invalid. Open the request from your Dean dashboard.');
        setCurrentLetterId(letterId);
        setDeanDetailStatus('error');
        setDeanRefreshVersion((version) => version + 1);
      } else {
        setStudentDetailError('The letter link is invalid. Open a letter from your records.');
        setCurrentLetterId(letterId);
        setStudentDetailStatus('error');
      }
      return;
    }

    if (profileRole === 'dean') setDeanRefreshVersion((version) => version + 1);
    void openLetter(letterId);
  }, [profileRole, deanLettersStatus, studentLettersStatus]);

  useEffect(() => {
    let active = true;
    const requestId = ++studentEvidenceRequestId.current;
    if (profileRole !== 'student' || !studentDetail?.id) {
      setStudentEvidence([]);
      setStudentEvidenceStatus('idle');
      setStudentEvidenceError('');
      setStudentEvidenceFile(null);
      setStudentEvidenceFileError('');
      setStudentEvidenceSuccess('');
      setStudentEvidenceLinks({});
      return () => { active = false; };
    }

    setStudentEvidence([]);
    setStudentEvidenceStatus('loading');
    setStudentEvidenceError('');
    setStudentEvidenceFile(null);
    setStudentEvidenceFileError('');
    setStudentEvidenceSuccess('');
    setStudentEvidenceLinks({});

    getStudentEvidence(studentDetail.id)
      .then((records) => {
        if (!active || requestId !== studentEvidenceRequestId.current) return;
        setStudentEvidence(records);
        setStudentEvidenceStatus('ready');
      })
      .catch((error) => {
        if (!active || requestId !== studentEvidenceRequestId.current) return;
        setStudentEvidenceError(studentDataFailureMessage(error));
        setStudentEvidenceStatus('error');
      });

    return () => { active = false; };
  }, [profileRole, studentDetail?.id]);

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

  function navigate(nextScreen) {
    if (nextScreen === 'submit' && (profileRole !== 'student' || !profile?.program_id)) return;
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
    if (profileRole === 'dean') {
      const requestId = ++deanDetailRequestId.current;
      deanEvidenceRequestId.current += 1;
      setDeanDetail(null);
      setDeanDetailError('');
      setDeanDetailStatus('loading');
      setDeanEvidenceLinks({});
      setDeanEvidenceLinkLoading('');
      setDeanDecisionError('');
      setDeanDecisionSuccess('');
      try {
        const detail = await getDeanLetterDetails(id);
        if (requestId !== deanDetailRequestId.current) return;
        if (!detail) {
          setDeanDetailError('This letter could not be found or is no longer available.');
          setDeanDetailStatus('error');
          return;
        }
        setDeanDetail(detail);
        setDeanDetailStatus('ready');
        if (detail.status !== 'pending') {
          try {
            const notification = await getStudentDecisionNotification(id, detail.status);
            if (requestId !== deanDetailRequestId.current) return;
            setDeanNotificationStates((current) => ({
              ...current,
              [id]: notification?.status === 'sent'
                ? { status: 'sent', message: 'The student email was sent.' }
                : notification?.status === 'sending'
                  ? { status: 'in_progress', message: 'The student email is being processed.' }
                  : notification?.status === 'failed'
                    ? { status: 'failed', message: 'The previous student email attempt failed. You can retry it.' }
                    : { status: 'not_sent', message: 'No student email attempt is recorded. You can send it now.' },
            }));
          } catch {
            if (requestId !== deanDetailRequestId.current) return;
            setDeanNotificationStates((current) => ({
              ...current,
              [id]: {
                status: 'failed',
                message: 'Could not load the previous email status. You can safely retry the student email.',
              },
            }));
          }
        }
      } catch (error) {
        if (requestId !== deanDetailRequestId.current) return;
        setDeanDetailError(reviewDataFailureMessage(error));
        setDeanDetailStatus('error');
      }
      return;
    }

    if (profileRole === 'professor') {
      const requestId = ++professorDetailRequestId.current;
      const identityRequestId = ++professorIdentityRequestId.current;
      const evidenceRequestId = ++professorEvidenceRequestId.current;
      professorEvidenceLinkRequestId.current += 1;
      setProfessorDetail(null);
      setProfessorDetailError('');
      setProfessorDetailStatus('loading');
      setProfessorStudentIdentity(null);
      setProfessorStudentIdentityError('');
      setProfessorStudentIdentityStatus('idle');
      setProfessorEvidence([]);
      setProfessorEvidenceError('');
      setProfessorEvidenceStatus('idle');
      setProfessorEvidenceLinks({});
      setProfessorEvidenceLinkLoading('');
      setProfessorEvidenceLinkError('');
      try {
        const detail = await getProfessorLetterDetails(id);
        if (requestId !== professorDetailRequestId.current) return;
        if (!detail) {
          setProfessorDetailError('This approved letter could not be found or is no longer available.');
          setProfessorDetailStatus('error');
          return;
        }
        setProfessorDetail(detail);
        setProfessorDetailStatus('ready');
        setProfessorStudentIdentityStatus('loading');
        void loadProfessorStudentIdentity(id, identityRequestId);
        void loadProfessorEvidence(id, evidenceRequestId);
      } catch (error) {
        if (requestId !== professorDetailRequestId.current) return;
        setProfessorDetailError(professorDataFailureMessage(error));
        setProfessorDetailStatus('error');
      }
      return;
    }

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
    studentEvidenceRequestId.current += 1;
    deanDetailRequestId.current += 1;
    deanEvidenceRequestId.current += 1;
    professorDetailRequestId.current += 1;
    professorIdentityRequestId.current += 1;
    professorEvidenceRequestId.current += 1;
    professorEvidenceLinkRequestId.current += 1;
    setCurrentLetterId(null);
    setStudentDetail(null);
    setStudentDetailError('');
    setStudentDetailStatus('idle');
    setStudentEvidence([]);
    setStudentEvidenceStatus('idle');
    setStudentEvidenceError('');
    setStudentEvidenceFile(null);
    setStudentEvidenceFileError('');
    setStudentEvidenceSuccess('');
    setStudentEvidenceLinks({});
    setDeanDetail(null);
    setDeanDetailStatus('idle');
    setDeanDetailError('');
    setDeanEvidenceLinks({});
    setDeanEvidenceLinkLoading('');
    setDeanDecisionBusy(false);
    setDeanDecisionError('');
    setDeanDecisionSuccess('');
    setProfessorDetail(null);
    setProfessorDetailStatus('idle');
    setProfessorDetailError('');
    setProfessorStudentIdentity(null);
    setProfessorStudentIdentityStatus('idle');
    setProfessorStudentIdentityError('');
    setProfessorEvidence([]);
    setProfessorEvidenceStatus('idle');
    setProfessorEvidenceError('');
    setProfessorEvidenceLinks({});
    setProfessorEvidenceLinkLoading('');
    setProfessorEvidenceLinkError('');
  }

  async function loadProfessorStudentIdentity(letterId, requestId) {
    try {
      const identity = await getProfessorLetterStudentIdentity(letterId);
      if (requestId !== professorIdentityRequestId.current) return;
      setProfessorStudentIdentity(identity);
      setProfessorStudentIdentityStatus('ready');
    } catch (error) {
      if (requestId !== professorIdentityRequestId.current) return;
      setProfessorStudentIdentity(null);
      setProfessorStudentIdentityError(professorDataFailureMessage(error));
      setProfessorStudentIdentityStatus('error');
    }
  }

  async function requestProfessorTableIdentity(letterId, accountId, isRequestCurrent = () => true) {
    const requestId = (professorTableIdentityRequestIds.current[letterId] || 0) + 1;
    professorTableIdentityRequestIds.current[letterId] = requestId;
    setProfessorTableIdentities((current) => updateProfessorIdentityState(current, {
      letterId,
      accountId,
      requestId,
      status: 'loading',
      identity: null,
    }));

    try {
      const identity = await getProfessorLetterStudentIdentity(letterId);
      const staleReason = !isRequestCurrent()
        ? 'effect-cleanup'
        : professorTableIdentityAccountId.current !== accountId
          ? 'account-changed'
          : professorTableIdentityRequestIds.current[letterId] !== requestId
            ? 'request-replaced'
            : null;
      if (staleReason) {
        return;
      }

      setProfessorTableIdentities((current) => {
        const next = updateProfessorIdentityState(current, {
          letterId,
          accountId,
          requestId,
          status: identity ? 'ready' : 'unavailable',
          identity,
        });
        return next;
      });
    } catch (error) {
      const staleReason = !isRequestCurrent()
        ? 'effect-cleanup'
        : professorTableIdentityAccountId.current !== accountId
          ? 'account-changed'
          : professorTableIdentityRequestIds.current[letterId] !== requestId
            ? 'request-replaced'
            : null;
      if (staleReason) return;

      console.error('Professor table identity request failed.', error);
      setProfessorTableIdentities((current) => updateProfessorIdentityState(current, {
        letterId,
        accountId,
        requestId,
        status: 'error',
        identity: null,
      }));
    }
  }

  function retryProfessorTableIdentity(letterId) {
    if (
      profileRole !== 'professor'
      || professorLettersStatus !== 'ready'
      || !authUser?.id
      || !professorLetters.some((letter) => letter.id === letterId)
      || professorTableIdentities.accountId === authUser.id
        && professorTableIdentities.byLetterId[letterId]?.status === 'loading'
    ) return;

    void requestProfessorTableIdentity(letterId, authUser.id);
  }

  function retryProfessorStudentIdentity() {
    if (!professorDetail?.id || professorStudentIdentityStatus === 'loading') return;
    const requestId = ++professorIdentityRequestId.current;
    setProfessorStudentIdentity(null);
    setProfessorStudentIdentityError('');
    setProfessorStudentIdentityStatus('loading');
    void loadProfessorStudentIdentity(professorDetail.id, requestId);
  }

  async function loadProfessorEvidence(letterId, requestId) {
    setProfessorEvidence([]);
    setProfessorEvidenceError('');
    setProfessorEvidenceStatus('loading');
    try {
      const records = await getProfessorEvidence(letterId);
      if (requestId !== professorEvidenceRequestId.current) return;
      setProfessorEvidence(records);
      setProfessorEvidenceStatus('ready');
    } catch (error) {
      if (requestId !== professorEvidenceRequestId.current) return;
      setProfessorEvidenceError(professorDataFailureMessage(error));
      setProfessorEvidenceStatus('error');
    }
  }

  function refreshProfessorEvidence() {
    if (!professorDetail?.id || professorEvidenceStatus === 'loading') return;
    const requestId = ++professorEvidenceRequestId.current;
    void loadProfessorEvidence(professorDetail.id, requestId);
  }

  async function prepareProfessorEvidenceLink(evidenceId) {
    const requestId = ++professorEvidenceLinkRequestId.current;
    setProfessorEvidenceLinkLoading(evidenceId);
    setProfessorEvidenceLinkError('');
    try {
      const signedUrl = await getProfessorEvidenceSignedUrl(evidenceId);
      if (requestId !== professorEvidenceLinkRequestId.current) return;
      setProfessorEvidenceLinks((current) => ({ ...current, [evidenceId]: signedUrl }));
    } catch (error) {
      if (requestId !== professorEvidenceLinkRequestId.current) return;
      setProfessorEvidenceLinkError(professorDataFailureMessage(error));
    } finally {
      if (requestId === professorEvidenceLinkRequestId.current) setProfessorEvidenceLinkLoading('');
    }
  }

  async function prepareDeanEvidenceLink(evidenceId) {
    const requestId = deanEvidenceRequestId.current;
    setDeanEvidenceLinkLoading(evidenceId);
    setDeanDetailError('');
    try {
      const signedUrl = await getDeanEvidenceSignedUrl(evidenceId);
      if (requestId !== deanEvidenceRequestId.current) return;
      setDeanEvidenceLinks((current) => ({ ...current, [evidenceId]: signedUrl }));
    } catch (error) {
      if (requestId !== deanEvidenceRequestId.current) return;
      setDeanDetailError(reviewDataFailureMessage(error));
    } finally {
      if (requestId === deanEvidenceRequestId.current) setDeanEvidenceLinkLoading('');
    }
  }

  async function decideDeanLetter(decision) {
    if (profileRole !== 'dean' || deanDetail?.status !== 'pending' || deanDecisionBusy) return;
    const label = decision === 'approved' ? 'approve' : 'disapprove';
    if (!window.confirm(`Confirm that you want to ${label} this excuse letter? This decision cannot be changed.`)) return;

    const letterId = deanDetail.id;
    const requestId = deanDetailRequestId.current;
    setDeanDecisionBusy(true);
    setDeanDecisionError('');
    setDeanDecisionSuccess('');
    try {
      const result = await submitDeanDecision({
        letterId,
        decision,
        comment: decisionComment,
      });
      setDeanDetail((current) => current && current.id === letterId
        ? { ...current, ...result }
        : current);
      setDeanDecisionSuccess(`Letter ${decision}. The decision has been recorded.`);
      setDeanRefreshVersion((version) => version + 1);
      showToast(`Letter ${decision}.`);

      setDeanNotificationStates((current) => ({
        ...current,
        [letterId]: { status: 'sending', message: 'Sending the student email…' },
      }));
      void deliverStudentDecisionNotification(letterId);

      try {
        const refreshedDetail = await getDeanLetterDetails(letterId);
        if (requestId === deanDetailRequestId.current && refreshedDetail) {
          setDeanDetail(refreshedDetail);
        }
      } catch (refreshError) {
        if (requestId === deanDetailRequestId.current) {
          setDeanDetailError(`The decision was saved, but the latest details could not be refreshed. ${reviewDataFailureMessage(refreshError)}`);
        }
      }
    } catch (error) {
      setDeanDecisionError(reviewDataFailureMessage(error));
    } finally {
      setDeanDecisionBusy(false);
    }
  }

  async function retryDeanStudentNotification() {
    const letterId = deanDetail?.id;
    const notificationState = deanNotificationStates[letterId];
    if (profileRole !== 'dean' || !letterId || deanDetail.status === 'pending'
        || notificationState?.status === 'sending') return;

    setDeanNotificationStates((current) => ({
      ...current,
      [letterId]: { status: 'sending', message: 'Retrying the student email…' },
    }));
    await deliverStudentDecisionNotification(letterId);
  }

  async function deliverStudentDecisionNotification(letterId) {
    try {
      const notification = await sendStudentDecisionNotification(letterId);
      setDeanNotificationStates((current) => ({
        ...current,
        [letterId]: notification.inProgress
          ? { status: 'in_progress', message: 'The student email is already being processed. You can check again shortly.' }
          : {
            status: 'sent',
            message: notification.alreadySent
              ? 'The student email was already sent.'
              : 'The student email was sent.',
          },
      }));
    } catch (error) {
      setDeanNotificationStates((current) => ({
        ...current,
        [letterId]: {
          status: 'failed',
          message: error.message || 'The decision was saved, but the student email could not be sent.',
        },
      }));
    }
  }

  function selectStudentEvidence(event) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    setStudentEvidenceSuccess('');
    setStudentEvidenceFileError(file ? validateEvidenceFile(file) : '');
    setStudentEvidenceFile(file);
  }

  function selectSubmissionEvidence(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    const validationErrors = files
      .map((file) => {
        const error = validateEvidenceFile(file);
        return error ? `${file.name}: ${error}` : '';
      })
      .filter(Boolean);

    setStudentSubmissionFiles(files);
    setStudentSubmissionFileError(validationErrors.join(' '));
    setStudentSubmitError('');
    setStudentSubmissionNotice('');
  }

  function removeSubmissionEvidence(indexToRemove) {
    const remainingFiles = studentSubmissionFiles.filter((_, index) => index !== indexToRemove);
    const validationErrors = remainingFiles
      .map((file) => {
        const error = validateEvidenceFile(file);
        return error ? `${file.name}: ${error}` : '';
      })
      .filter(Boolean);
    setStudentSubmissionFiles(remainingFiles);
    setStudentSubmissionFileError(validationErrors.join(' '));
  }

  async function submitStudentEvidence(event) {
    event.preventDefault();
    if (!studentDetail?.id || !studentEvidenceFile || studentEvidenceUploading) return;

    const validationError = validateEvidenceFile(studentEvidenceFile);
    if (validationError) {
      setStudentEvidenceFileError(validationError);
      return;
    }

    const requestId = studentEvidenceRequestId.current;
    setStudentEvidenceUploading(true);
    setStudentEvidenceFileError('');
    setStudentEvidenceError('');
    setStudentEvidenceSuccess('');
    try {
      await uploadStudentEvidence({ letterId: studentDetail.id, file: studentEvidenceFile });
      if (requestId !== studentEvidenceRequestId.current) return;
      setStudentEvidenceFile(null);
      setStudentEvidenceSuccess('Evidence uploaded successfully.');
      try {
        const records = await getStudentEvidence(studentDetail.id);
        if (requestId !== studentEvidenceRequestId.current) return;
        setStudentEvidence(records);
        setStudentEvidenceStatus('ready');
      } catch (error) {
        if (requestId !== studentEvidenceRequestId.current) return;
        setStudentEvidenceStatus('error');
        setStudentEvidenceError(studentDataFailureMessage(error));
      }
    } catch (error) {
      if (requestId !== studentEvidenceRequestId.current) return;
      setStudentEvidenceFileError(studentDataFailureMessage(error));
    } finally {
      if (requestId === studentEvidenceRequestId.current) setStudentEvidenceUploading(false);
    }
  }

  async function prepareStudentEvidenceLink(evidenceId) {
    const requestId = studentEvidenceRequestId.current;
    setStudentEvidenceLinkLoading(evidenceId);
    setStudentEvidenceError('');
    try {
      const signedUrl = await getStudentEvidenceSignedUrl(evidenceId);
      if (requestId !== studentEvidenceRequestId.current) return;
      setStudentEvidenceLinks((current) => ({ ...current, [evidenceId]: signedUrl }));
    } catch (error) {
      if (requestId !== studentEvidenceRequestId.current) return;
      setStudentEvidenceError(studentDataFailureMessage(error));
    } finally {
      if (requestId === studentEvidenceRequestId.current) setStudentEvidenceLinkLoading('');
    }
  }

  async function refreshStudentEvidence() {
    if (!studentDetail?.id) return;
    const requestId = ++studentEvidenceRequestId.current;
    setStudentEvidenceStatus('loading');
    setStudentEvidenceError('');
    try {
      const records = await getStudentEvidence(studentDetail.id);
      if (requestId !== studentEvidenceRequestId.current) return;
      setStudentEvidence(records);
      setStudentEvidenceStatus('ready');
    } catch (error) {
      if (requestId !== studentEvidenceRequestId.current) return;
      setStudentEvidenceError(studentDataFailureMessage(error));
      setStudentEvidenceStatus('error');
    }
  }

  async function handleSubmitLetter(event) {
    event.preventDefault();
    if (profileRole !== 'student' || !authUser?.id || studentSubmitting) return;
    if (!profile?.program_id) {
      setStudentSubmitError(studentProgramMissingMessage);
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(event.currentTarget);
    const courseId = String(data.get('courseId') || '');
    const absenceStart = String(data.get('absenceStart') || '');
    const absenceEnd = String(data.get('absenceEnd') || '');
    const reason = String(data.get('reason') || '').trim();
    setStudentSubmitError('');
    setStudentSubmissionNotice('');
    setStudentSubmitProgress('');

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
    const validationErrors = studentSubmissionFiles
      .map((file) => {
        const error = validateEvidenceFile(file);
        return error ? `${file.name}: ${error}` : '';
      })
      .filter(Boolean);
    if (validationErrors.length) {
      setStudentSubmissionFileError(validationErrors.join(' '));
      return;
    }

    setStudentSubmitting(true);
    setStudentSubmitProgress('Creating your excuse letter…');
    try {
      const createdLetter = await createStudentLetterWithEvidence({
        studentId: authUser.id,
        programId: profile.program_id,
        courseId,
        absenceStart,
        absenceEnd,
        reason,
        enrolledCourses: studentCourses,
        evidenceFiles: studentSubmissionFiles,
        onEvidenceProgress: (current, total) => {
          setStudentSubmitProgress(`Uploading evidence ${current} of ${total}…`);
        },
      });
      setStudentLetters((current) => [createdLetter, ...current]);
      setStudentLettersStatus('ready');
      form.reset();
      setStudentSubmissionFiles([]);
      setStudentSubmissionFileError('');
      setStudentSubmitProgress('');
      navigate('letters');
      showToast(studentSubmissionFiles.length
        ? 'Your excuse letter and evidence were submitted for review.'
        : 'Your excuse letter was submitted for review.');
    } catch (error) {
      if (error instanceof StudentLetterSubmissionError) {
        setStudentLetters((current) => [error.letter, ...current.filter((letter) => letter.id !== error.letter.id)]);
        setStudentLettersStatus('ready');
        setStudentSubmissionNotice(error.message);
        form.reset();
        setStudentSubmissionFiles([]);
        setStudentSubmissionFileError('');
        navigate('letters');
        return;
      }
      setStudentSubmitError(studentDataFailureMessage(error));
    } finally {
      setStudentSubmitting(false);
      setStudentSubmitProgress('');
    }
  }

  const sortedLetters = [...visibleLetters].sort((a, b) => b.submitted.localeCompare(a.submitted));
  const deanLetterSummary = sortedLetters.reduce((summary, letter) => {
    if (letter.status === 'Pending') summary.pending += 1;
    if (letter.status === 'Approved') summary.approved += 1;
    if (letter.status === 'Disapproved') summary.rejected += 1;
    return summary;
  }, { pending: 0, approved: 0, rejected: 0 });
  const dashboardLetters = profileRole === 'dean' ? sortedLetters.filter((letter) => letter.status === 'Pending') : sortedLetters;
  const matches = (letter, text, status) => (!text || `${letter.studentName} ${letter.studentNumber} ${letter.course} ${letter.professor}`.toLowerCase().includes(text.toLowerCase()))
    && (status === 'all' || letter.status.toLowerCase() === status.toLowerCase());
  const allLetters = sortedLetters.filter((letter) => profileRole === 'dean'
    ? letter.status === 'Pending'
    : matches(letter, search, filter));
  const historyLetters = sortedLetters.filter((letter) => matches(letter, historySearch, historyFilter));
  const professorFilteredLetters = professorLetters
    .map(toProfessorLetterView)
    .filter((letter) => (!search || letter.course.toLowerCase().includes(search.toLowerCase()))
      && (professorCourseFilter === 'all' || letter.courseId === professorCourseFilter)
      && (!professorDateFromFilter || letter.dateTo >= professorDateFromFilter)
      && (!professorDateToFilter || letter.dateFrom <= professorDateToFilter));
  const professorTableIdentityByLetterId = getProfessorIdentityStatesForAccount(
    professorTableIdentities,
    authUser?.id,
  );
  const professorLatestApprovals = [...professorLetters]
    .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''))
    .slice(0, 4)
    .map(toProfessorLetterView);
  const pendingCount = profileRole === 'dean'
    ? deanLetterSummary.pending
    : profileRole === 'professor'
      ? professorCoursesStatus === 'error' || professorLettersStatus === 'error' ? '—' : professorLetters.length
      : visibleLetters.filter((letter) => letter.status === 'Pending').length;
  const activeLetter = profileRole === 'student'
    ? studentDetail && toStudentLetterView(studentDetail, profile, authUser)
    : profileRole === 'dean'
      ? deanDetail && toDeanLetterView(deanDetail)
      : profileRole === 'professor'
        ? professorDetail && toProfessorLetterView(professorDetail)
        : letters.find((letter) => letter.id === currentLetterId);
  const studentDetailOpen = profileRole === 'student' && Boolean(currentLetterId);
  const deanDetailOpen = profileRole === 'dean' && Boolean(currentLetterId);
  const professorDetailOpen = profileRole === 'professor' && Boolean(currentLetterId);
  const modalOpen = studentDetailOpen || deanDetailOpen || professorDetailOpen || Boolean(activeLetter);

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
    dean: ['Good morning, Dean.', 'Review requests and record decisions.', 'Needs your review', 'Pending requests are ready for a decision', 'Pending Reviews', 'Review submissions and record a decision with an optional comment.', 'Pending Reviews'],
    professor: [`Good morning, ${displayName.split(/\s+/)[0]}.`, 'Your assigned courses and Dean-approved excuse letters.', 'Approved for your courses', 'Only approved letters for your assigned course offerings', 'Approved letters', 'Read-only access to approved letters for your assigned courses.', 'Approved letters'],
  }[profileRole];
  const statuses = ['all', 'Pending', 'Approved', 'Disapproved'];

  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand"><img className="brand-mark" src={logo} alt="University of the Assumption seal" /><div><div className="brand-name">University of the<br />Assumption</div><div className="brand-sub">Pampanga · Student Affairs</div></div></div>
          <div className="side-label">Workspace</div>
          <nav className="nav" aria-label="Main navigation">
            {[['dashboard', 'OV', 'Overview'], ['letters', 'EL', roleCopy[6]], ...(profileRole === 'student' ? [['history', 'HI', 'Letter history']] : profileRole === 'dean' ? [['history', 'HI', 'Letter History']] : [])].map(([key, icon, label]) => (
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
            {profileRole === 'student' && !profile?.program_id && <p className="student-program-warning" role="alert">{studentProgramMissingMessage}</p>}
            {screen === 'dashboard' && (
              <section className="screen active">
                <div className="page-heading"><div><div className="eyebrow">University of the Assumption · San Fernando, Pampanga</div><h1>{roleCopy[0].replace('Mika', displayName.split(/\s+/)[0])}</h1><p className="subtitle">{roleCopy[1]}</p></div>{profileRole === 'student' && <button className="primary" onClick={() => navigate('submit')} disabled={!profile?.program_id} type="button">+ &nbsp; New excuse letter</button>}</div>
                <div className={`stats${profileRole === 'professor' ? ' professor-stats' : ''}${profileRole === 'dean' ? ' dean-stats' : ''}`}>
                  {(profileRole === 'dean' ? [
                    ['Pending Letters', deanLettersStatus === 'loading' ? '…' : deanLettersStatus === 'error' ? '—' : pendingCount, 'Awaiting your review', '!', 'stat--pending'],
                    ['Approved Letters', deanLettersStatus === 'loading' ? '…' : deanLettersStatus === 'error' ? '—' : deanLetterSummary.approved, 'Approved requests', '✓', 'stat--approved'],
                    ['Rejected Letters', deanLettersStatus === 'loading' ? '…' : deanLettersStatus === 'error' ? '—' : deanLetterSummary.rejected, 'Rejected requests', '×', 'stat--rejected'],
                    ['Total Reviewed', deanLettersStatus === 'loading' ? '…' : deanLettersStatus === 'error' ? '—' : deanLetterSummary.approved + deanLetterSummary.rejected, 'Approved and rejected', 'Σ', 'stat--reviewed'],
                  ] : profileRole === 'professor' ? [
                    ['Assigned courses', professorCoursesStatus === 'loading' ? '…' : professorCoursesStatus === 'error' ? '—' : professorCourses.length, 'Courses assigned to your account', 'C'],
                    ['Approved letters', professorCoursesStatus === 'error' || professorLettersStatus === 'error' ? '—' : professorLettersStatus === 'loading' || professorCoursesStatus === 'loading' ? '…' : professorLetters.length, 'Dean-approved letters for your courses', '✓'],
                  ] : [
                    ['Total letters', profileRole === 'student' && studentLettersStatus === 'loading' ? '…' : profileRole === 'student' && studentLettersStatus === 'error' ? '—' : visibleLetters.length, 'Across your records', 'EL'],
                    ['Awaiting review', profileRole === 'student' && studentLettersStatus === 'loading' ? '…' : profileRole === 'student' && studentLettersStatus === 'error' ? '—' : visibleLetters.filter((item) => item.status === 'Pending').length, 'In the Dean’s queue', '…'],
                    ['Approved', profileRole === 'student' && studentLettersStatus === 'loading' ? '…' : profileRole === 'student' && studentLettersStatus === 'error' ? '—' : visibleLetters.filter((item) => item.status === 'Approved').length, 'Ready to view', 'OK'],
                    ['Disapproved', profileRole === 'student' && studentLettersStatus === 'loading' ? '…' : profileRole === 'student' && studentLettersStatus === 'error' ? '—' : visibleLetters.filter((item) => item.status === 'Disapproved').length, 'See Dean comments', 'NO'],
                  ]).map(([label, value, note, mark, cardClass]) => <div className={`stat${cardClass ? ` ${cardClass}` : ''}`} key={label}><div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></div><div className="stat-mark">{mark}</div></div>)}
                </div>
                {profileRole === 'professor' ? (
                  <div className="workspace professor-workspace">
                    <section className="panel">
                      <div className="panel-head">
                        <div><div className="panel-title">Approved excuse letters</div><div className="panel-kicker">Dean-approved letters for your assigned courses</div></div>
                        <button className="secondary" type="button" onClick={() => setProfessorRefreshVersion((version) => version + 1)} disabled={professorCoursesStatus === 'loading' || professorLettersStatus === 'loading'}>Refresh</button>
                      </div>
                      {professorCoursesError && <p className="student-data-error" role="alert">{professorCoursesError}</p>}
                      {professorLettersError && <p className="student-data-error" role="alert">{professorLettersError}</p>}
                      <LetterTable
                        items={dashboardLetters.slice(0, 5)}
                        mode="professor"
                        profileRole="professor"
                        onOpen={openLetter}
                        professorIdentities={professorTableIdentityByLetterId}
                        onRetryProfessorIdentity={retryProfessorTableIdentity}
                        emptyText={professorCoursesStatus === 'loading' ? 'Loading assigned courses…' : professorCoursesStatus === 'error' ? 'Assigned courses could not be loaded.' : professorCourses.length === 0 ? 'No courses are assigned to your account.' : professorLettersStatus === 'loading' ? 'Loading approved letters…' : professorLettersStatus === 'error' ? 'Approved letters could not be loaded.' : 'Your assigned courses have no approved excuse letters yet.'}
                      />
                    </section>
                    <aside className="right-col">
                      <section className="panel">
                        <div className="panel-head"><div><div className="panel-title">Assigned courses</div><div className="panel-kicker">{professorCoursesStatus === 'loading' ? 'Loading your course assignments…' : professorCoursesStatus === 'error' ? 'Assignments unavailable' : `${professorCourses.length} assigned course${professorCourses.length === 1 ? '' : 's'}`}</div></div></div>
                        {professorCoursesStatus === 'loading' && <div className="empty-state" role="status">Loading assigned courses…</div>}
                        {professorCoursesStatus === 'error' && <div className="professor-course-error"><p className="student-data-error" role="alert">{professorCoursesError}</p><button className="secondary" type="button" onClick={() => setProfessorRefreshVersion((version) => version + 1)}>Retry</button></div>}
                        {professorCoursesStatus === 'ready' && professorCourses.length === 0 && <div className="empty-state">No courses are assigned to your account.</div>}
                        {professorCoursesStatus === 'ready' && professorCourses.length > 0 && <ul className="professor-course-list">{professorCourses.map((course) => <li key={course.id}><strong>{course.course_code} · {course.course_name}</strong><span>{course.section ? `Section ${course.section}` : 'Section not specified'}</span></li>)}</ul>}
                      </section>
                      <section className="panel professor-latest-approvals">
                        <div className="panel-head"><div><div className="panel-title">Latest approvals</div><div className="panel-kicker">Recent Dean decisions for your courses</div></div></div>
                        {professorCoursesStatus === 'loading' && <div className="empty-state" role="status">Loading approved-letter activity…</div>}
                        {(professorCoursesStatus === 'error' || professorLettersStatus === 'error') && <div className="empty-state student-data-error" role="alert">Approval activity could not be loaded.</div>}
                        {professorCoursesStatus === 'ready' && professorLettersStatus === 'loading' && <div className="empty-state" role="status">Loading approved-letter activity…</div>}
                        {professorCoursesStatus === 'ready' && professorLettersStatus === 'ready' && professorLatestApprovals.length === 0 && <div className="empty-state">No approved-letter activity yet.</div>}
                        {professorCoursesStatus === 'ready' && professorLettersStatus === 'ready' && professorLatestApprovals.length > 0 && <div className="professor-activity-list">{professorLatestApprovals.map((letter) => <div className="professor-activity-item" key={letter.id}><strong>{letter.course}</strong><span>Approved {formatDate(letter.approvedAt)}</span></div>)}</div>}
                      </section>
                    </aside>
                  </div>
                ) : (
                <div className="workspace">
                  <section className="panel"><div className="panel-head"><div><div className="panel-title">{profileRole === 'dean' ? 'Pending Requests' : roleCopy[2]}</div><div className="panel-kicker">{roleCopy[3]}</div></div><div className="table-tools">{profileRole === 'student' && <button className="secondary" onClick={() => setStudentRefreshVersion((version) => version + 1)} type="button" disabled={studentLettersStatus === 'loading'}>Refresh</button>}{profileRole === 'dean' && <button className="secondary" onClick={() => setDeanRefreshVersion((version) => version + 1)} type="button" disabled={deanLettersStatus === 'loading'}>Refresh</button>}{profileRole === 'student' && <button className="secondary" onClick={() => navigate('history')} type="button">View history</button>}</div></div>
                    {profileRole === 'dean' && deanLettersError && <p className="student-data-error" role="alert">{deanLettersError}</p>}
                    <LetterTable
                      items={dashboardLetters.slice(0, 5)}
                      mode={profileRole === 'student' ? 'student' : profileRole === 'dean' ? 'dean' : 'recent'}
                      profileRole={profileRole}
                      onOpen={openLetter}
                      tableClass={profileRole === 'student' ? 'student-dashboard-table' : ''}
                      emptyText={profileRole === 'dean' ? deanLettersStatus === 'loading' ? 'Loading pending letters…' : deanLettersStatus === 'error' ? 'Pending letters could not be loaded.' : 'There are no pending excuse letters to review.' : profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your letters…' : profileRole === 'student' && studentLettersStatus === 'error' ? studentLettersError : profileRole === 'student' ? 'No excuse letters submitted yet.' : 'Nothing here yet. New letters will appear as they are submitted.'}
                    />
                  </section>
                  {profileRole === 'student' && <aside className="right-col">
                    <section className="notice student-dashboard-cta"><div className="notice-title">Ready to submit?</div><p>Start a new excuse letter.</p><button className="secondary" onClick={() => navigate('submit')} disabled={!profile?.program_id} type="button">Start a letter &nbsp; →</button></section>
                    <section className="panel"><div className="panel-head"><div><div className="panel-title">Latest activity</div><div className="panel-kicker">Updates from the letter desk</div></div></div><Activity items={visibleLetters} notifications={notifications} profileRole={profileRole} email={authUser.email} displayName={displayName} loading={studentLettersStatus === 'loading'} error={studentLettersError} /></section>
                  </aside>}
                </div>
                )}
              </section>
            )}
            {screen === 'letters' && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Excuse letter desk</div><h1>{roleCopy[4]}</h1><p className="subtitle">{roleCopy[5]}</p></div>{profileRole === 'student' && <button className="primary" onClick={() => navigate('submit')} disabled={!profile?.program_id} type="button">+ &nbsp; New excuse letter</button>}</div>
              {profileRole === 'professor' ? (
                <section className="panel">
                  <div className="panel-head professor-letter-tools">
                    <div><div className="panel-title">Approved letters</div><div className="panel-kicker">{professorCoursesStatus === 'loading' ? 'Loading assigned courses…' : professorCoursesStatus === 'error' ? 'Course assignments could not be loaded' : professorLettersStatus === 'loading' ? 'Loading approved letters…' : professorLettersStatus === 'error' ? 'Approved letters could not be loaded' : `${professorFilteredLetters.length} matching approved letter${professorFilteredLetters.length === 1 ? '' : 's'}`}</div></div>
                    <div className="professor-filters">
                      <input className="search" type="search" placeholder="Search courses" aria-label="Search courses" value={search} onChange={(event) => setSearch(event.target.value)} />
                      <select className="filter" aria-label="Filter by assigned course" value={professorCourseFilter} onChange={(event) => setProfessorCourseFilter(event.target.value)} disabled={professorCoursesStatus !== 'ready'}><option value="all">All courses</option>{professorCourses.map((course) => <option key={course.id} value={course.id}>{course.course_code} · {course.section}</option>)}</select>
                      <label className="professor-date-filter"><span>Absence from</span><input aria-label="Absence date from" type="date" value={professorDateFromFilter} onChange={(event) => setProfessorDateFromFilter(event.target.value)} /></label>
                      <label className="professor-date-filter"><span>Absence to</span><input aria-label="Absence date to" type="date" value={professorDateToFilter} onChange={(event) => setProfessorDateToFilter(event.target.value)} /></label>
                      <button className="secondary" type="button" onClick={() => setProfessorRefreshVersion((version) => version + 1)} disabled={professorCoursesStatus === 'loading' || professorLettersStatus === 'loading'}>Refresh</button>
                    </div>
                  </div>
                  {professorCoursesError && <p className="student-data-error" role="alert">{professorCoursesError}</p>}
                  {professorLettersError && <p className="student-data-error" role="alert">{professorLettersError}</p>}
                  <LetterTable items={professorFilteredLetters} mode="professor" profileRole="professor" onOpen={openLetter} professorIdentities={professorTableIdentityByLetterId} onRetryProfessorIdentity={retryProfessorTableIdentity} emptyText={professorCoursesStatus === 'loading' ? 'Loading assigned courses…' : professorCoursesStatus === 'error' ? 'Assigned courses could not be loaded.' : professorCourses.length === 0 ? 'No courses are assigned to your account.' : professorLettersStatus === 'loading' ? 'Loading approved letters…' : professorLettersStatus === 'error' ? 'Approved letters could not be loaded.' : professorLetters.length === 0 ? 'Your assigned courses have no approved excuse letters yet.' : 'No approved letters match these filters.'} />
                </section>
              ) : (
              <section className="panel"><div className="panel-head"><div><div className="panel-title">{profileRole === 'dean' ? 'Pending Reviews' : 'All letters'}</div><div className="panel-kicker">{profileRole === 'dean' ? deanLettersStatus === 'loading' ? 'Loading the review queue…' : `${pendingCount} pending letter${pendingCount === 1 ? '' : 's'}` : profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your records…' : `${sortedLetters.length} letter${sortedLetters.length === 1 ? '' : 's'} in this view`}</div></div><div className="table-tools">{profileRole === 'student' && <button className="secondary" onClick={() => setStudentRefreshVersion((version) => version + 1)} type="button" disabled={studentLettersStatus === 'loading'}>Refresh</button>}{profileRole === 'dean' && <button className="secondary" onClick={() => setDeanRefreshVersion((version) => version + 1)} type="button" disabled={deanLettersStatus === 'loading'}>Refresh</button>}{profileRole !== 'dean' && <><input className="search" type="search" placeholder="Search names or course" aria-label="Search letters" value={search} onChange={(event) => setSearch(event.target.value)} /><select className="filter" aria-label="Filter by status" value={filter} onChange={(event) => setFilter(event.target.value)}>{statuses.map((status) => <option key={status} value={status}>{status === 'all' ? 'All statuses' : status}</option>)}</select></>}</div></div>
                {profileRole === 'student' && studentSubmissionNotice && <p className="student-data-error" role="alert">{studentSubmissionNotice}</p>}
                {profileRole === 'student' && studentLettersError && <p className="student-data-error" role="alert">{studentLettersError}</p>}
                {profileRole === 'dean' && deanLettersError && <p className="student-data-error" role="alert">{deanLettersError}</p>}
                <LetterTable items={allLetters} mode={profileRole === 'student' ? 'student' : 'all'} profileRole={profileRole} onOpen={openLetter} emptyText={profileRole === 'dean' ? deanLettersStatus === 'loading' ? 'Loading pending letters…' : deanLettersStatus === 'error' ? 'Pending letters could not be loaded.' : 'There are no pending excuse letters to review.' : profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your letters…' : profileRole === 'student' && studentLettersStatus === 'error' ? studentLettersError : profileRole === 'student' ? 'No excuse letters match this view.' : 'No letters match this view.'} />
              </section>
              )}
            </section>}
            {screen === 'history' && (profileRole === 'student' || profileRole === 'dean') && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Records & decisions</div><h1>Letter History</h1><p className="subtitle">{profileRole === 'dean' ? 'All excuse letters available to your signed-in account, including pending and decided requests.' : 'A record of your submissions and any recorded status changes.'}</p></div></div>
              <section className="panel"><div className="panel-head"><div><div className="panel-title">Complete record</div><div className="panel-kicker">{profileRole === 'dean'
                ? deanLettersStatus === 'loading' ? 'Loading letters visible to your account…' : `${sortedLetters.length} visible letter${sortedLetters.length === 1 ? '' : 's'}`
                : studentLettersStatus === 'loading' ? 'Loading your records…' : `${sortedLetters.length} complete record${sortedLetters.length === 1 ? '' : 's'}`}</div></div><div className="table-tools">{profileRole === 'student' && <button className="secondary" onClick={() => setStudentRefreshVersion((version) => version + 1)} type="button" disabled={studentLettersStatus === 'loading'}>Refresh</button>}{profileRole === 'dean' && <button className="secondary" onClick={() => setDeanRefreshVersion((version) => version + 1)} type="button" disabled={deanLettersStatus === 'loading'}>Refresh</button>}<input className="search" type="search" placeholder="Search history" aria-label="Search history" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} /><select className="filter" aria-label="Filter history by status" value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)}>{(profileRole === 'dean' ? [{ value: 'all', label: 'All' }, { value: 'Pending', label: 'Pending' }, { value: 'Approved', label: 'Approved' }, { value: 'Disapproved', label: 'Rejected' }] : statuses.map((status) => ({ value: status, label: status === 'all' ? 'All statuses' : status }))).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div></div>
                {profileRole === 'student' && studentLettersError && <p className="student-data-error" role="alert">{studentLettersError}</p>}
                {profileRole === 'dean' && deanLettersError && <p className="student-data-error" role="alert">{deanLettersError}</p>}
                <LetterTable items={historyLetters} mode={profileRole === 'student' ? 'student' : 'history'} profileRole={profileRole} onOpen={openLetter} emptyText={profileRole === 'dean' ? deanLettersStatus === 'loading' ? 'Loading letters…' : deanLettersStatus === 'error' ? 'Letter history could not be loaded.' : 'No letters match this view.' : profileRole === 'student' && studentLettersStatus === 'loading' ? 'Loading your letters…' : profileRole === 'student' && studentLettersStatus === 'error' ? studentLettersError : 'No letters to show yet.'} />
              </section>
            </section>}
            {screen === 'submit' && profileRole === 'student' && <section className="screen active"><div className="page-heading"><div><div className="eyebrow">Student services · New request</div><h1>Submit an excuse letter</h1><p className="subtitle">Choose an enrolled course and enter the dates and reason for your absence.</p></div></div>
              <div className="letter-layout">
                <form className="panel form-panel" onSubmit={handleSubmitLetter}>
                  <div className="form-section"><h2 className="section-title">Student account</h2><p className="form-account">{profile?.full_name || authUser.email}{profile?.student_number ? ` · ${profile.student_number}` : ''}</p><p className="field-hint">Your signed-in account is used as the owner of this request.</p></div>
                  <div className="form-section"><h2 className="section-title">Class and absence</h2><div className="form-grid">
                    <div className="field full"><label htmlFor="course-id">Enrolled course / class *</label><select id="course-id" name="courseId" required disabled={!profile?.program_id || studentCoursesStatus !== 'ready' || studentCourses.length === 0 || studentSubmitting} defaultValue=""><option value="" disabled>{studentCoursesStatus === 'loading' ? 'Loading your enrolled courses…' : studentCoursesStatus === 'error' ? 'Courses could not be loaded' : studentCourses.length === 0 ? 'No enrolled courses found' : 'Choose an enrolled course'}</option>{studentCourses.map((course) => <option key={course.id} value={course.id}>{course.course_code} · {course.course_name}{course.section ? ` (${course.section})` : ''}</option>)}</select></div>
                    {studentCoursesStatus === 'error' && <div className="field full"><p className="student-data-error" role="alert">{studentCoursesError}</p><button className="secondary" type="button" onClick={() => setStudentRefreshVersion((version) => version + 1)}>Retry course loading</button></div>}
                    {studentCoursesStatus === 'ready' && studentCourses.length === 0 && <p className="field-hint full">No courses are currently linked to your account. Contact Student Affairs if you believe this is incorrect.</p>}
                    <div className="field"><label htmlFor="absence-start">Absence from *</label><input id="absence-start" name="absenceStart" type="date" required disabled={!profile?.program_id || studentSubmitting} /></div>
                    <div className="field"><label htmlFor="absence-end">Absence to *</label><input id="absence-end" name="absenceEnd" type="date" required disabled={!profile?.program_id || studentSubmitting} /></div>
                    <div className="field full"><label htmlFor="reason">Reason for absence *</label><textarea id="reason" name="reason" required maxLength={4000} placeholder="Briefly explain the reason for your absence" disabled={!profile?.program_id || studentSubmitting} /></div>
                  </div></div>
                  <div className="form-section student-submission-evidence">
                    <h2 className="section-title">Evidence (optional)</h2>
                    <p className="field-hint">Attach PDF, JPG/JPEG, or PNG files. Maximum 8 MiB per file.</p>
                    <label className="upload" htmlFor="student-submission-evidence">
                      Select evidence files
                      <input id="student-submission-evidence" type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" multiple disabled={!profile?.program_id || studentSubmitting} onChange={selectSubmissionEvidence} />
                    </label>
                    {studentSubmissionFiles.length > 0 && <ul className="submission-evidence-list">{studentSubmissionFiles.map((file, index) => (
                      <li key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
                        <span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MiB</small></span>
                        <button className="review-link" type="button" aria-label={`Remove ${file.name}`} disabled={!profile?.program_id || studentSubmitting} onClick={() => removeSubmissionEvidence(index)}>Remove</button>
                      </li>
                    ))}</ul>}
                    {studentSubmissionFileError && <p className="student-data-error" role="alert">{studentSubmissionFileError}</p>}
                    {studentSubmitProgress && <p className="field-hint" role="status" aria-live="polite">{studentSubmitProgress}</p>}
                  </div>
                  {studentSubmitError && <p className="student-data-error" role="alert">{studentSubmitError}</p>}
                  <div className="form-actions"><button type="button" className="secondary" onClick={() => navigate('dashboard')} disabled={studentSubmitting}>Cancel</button><button className="primary" type="submit" disabled={!profile?.program_id || studentSubmitting || Boolean(studentSubmissionFileError) || studentCoursesStatus !== 'ready' || studentCourses.length === 0}>{studentSubmitting ? 'Submitting…' : 'Submit excuse letter'}</button></div>
                </form>
                <aside className="panel side-note"><h3>What happens next</h3><p>Your request is saved with a pending status. You can check its current status and any later updates from your letter list.</p><div className="steps"><div className="step"><div className="step-number">1</div><div><strong>Submit your request</strong>Your account, enrolled course, absence dates, and reason are recorded.</div></div><div className="step"><div className="step-number">2</div><div><strong>Await the daily reminder</strong>The Dean receives one daily email summary of pending letters assigned to their programs.</div></div><div className="step"><div className="step-number">3</div><div><strong>Check your records</strong>Open the letter to review its status history.</div></div></div></aside>
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
                {activeLetter && <div className="qr-center"><QRCode letterId={activeLetter.id} /></div>}
                {activeLetter && <section className="student-evidence">
                  <div className="student-evidence-heading"><h3>Evidence</h3>{studentEvidenceStatus !== 'idle' && <button className="secondary" type="button" disabled={studentEvidenceStatus === 'loading'} onClick={refreshStudentEvidence}>Refresh</button>}</div>
                  {studentEvidenceStatus === 'loading' && <p className="student-detail-message" role="status">Loading evidence…</p>}
                  {studentEvidenceStatus === 'error' && <p className="student-data-error" role="alert">{studentEvidenceError}</p>}
                  {studentEvidenceStatus === 'ready' && studentEvidence.length === 0 && <p className="field-hint">No evidence has been uploaded for this letter.</p>}
                  {studentEvidence.length > 0 && <ul className="student-evidence-list">{studentEvidence.map((item) => (
                    <li key={item.id}>
                      <div><strong>{item.original_filename}</strong><small>{item.mime_type} · {(item.size_bytes / 1024 / 1024).toFixed(2)} MB · Uploaded {formatDateTime(item.uploaded_at)}</small></div>
                      {studentEvidenceLinks[item.id]
                        ? <div className="student-evidence-actions"><a className="secondary evidence-open" href={studentEvidenceLinks[item.id]} target="_blank" rel="noopener noreferrer">Open private file</a><button className="review-link" type="button" onClick={() => prepareStudentEvidenceLink(item.id)}>Get new link</button></div>
                        : <button className="secondary" type="button" disabled={studentEvidenceLinkLoading === item.id} onClick={() => prepareStudentEvidenceLink(item.id)}>{studentEvidenceLinkLoading === item.id ? 'Preparing…' : 'Get secure link'}</button>}
                    </li>
                  ))}</ul>}
                  {studentEvidenceStatus === 'ready' && studentDetail.status === 'pending' && <form className="student-evidence-upload" onSubmit={submitStudentEvidence}>
                    <label htmlFor="student-evidence-file">Add a file (PDF, JPG, or PNG; up to 8 MB)</label>
                    <input id="student-evidence-file" type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" disabled={studentEvidenceUploading} onChange={selectStudentEvidence} />
                    {studentEvidenceFile && <p className="field-hint">Selected: {studentEvidenceFile.name} · {(studentEvidenceFile.size / 1024 / 1024).toFixed(2)} MB</p>}
                    {studentEvidenceFileError && <p className="student-data-error" role="alert">{studentEvidenceFileError}</p>}
                    {studentEvidenceSuccess && <p className="student-evidence-success" role="status">{studentEvidenceSuccess}</p>}
                    <button className="primary" type="submit" disabled={!studentEvidenceFile || studentEvidenceUploading || Boolean(studentEvidenceFileError)}>{studentEvidenceUploading ? 'Uploading…' : 'Upload evidence'}</button>
                  </form>}
                  {activeLetter.status !== 'pending' && <p className="field-hint">Evidence uploads are available only while the letter is pending. Deletion is not available.</p>}
                </section>}
              </div>
              <div className="modal-actions"><button className="secondary" onClick={closeLetter} type="button">Close</button><span className="modal-hint">Status changes are not available in this phase.</span></div>
            </>
          ) : deanDetailOpen ? (
            <>
              <div className="modal-head"><div><h2 id="modal-title">{deanDetail?.student?.full_name || 'Excuse letter review'}</h2><p>{deanDetail ? `${deanDetail.id} · Submitted ${formatDate(deanDetail.submitted_at)}` : 'Loading submission details'}</p></div><button className="close" onClick={closeLetter} aria-label="Close" type="button">×</button></div>
              <div className="modal-content">
                {deanDetailStatus === 'loading' && <p className="student-detail-message" role="status">Loading letter details…</p>}
                {deanDetailError && <p className="student-data-error" role="alert">{deanDetailError}</p>}
                {deanDetail && <div className="detail-grid">
                  <Detail label="Student" value={deanDetail.student?.full_name} />
                  <Detail label="Student number" value={deanDetail.student?.student_number} />
                  <Detail label="Program" value={deanDetail.student?.program} />
                  <Detail label="Course / section" value={activeLetter?.course} />
                  <Detail label="Professor" value={activeLetter?.professor} />
                  <div><div className="detail-label">Status</div><div className="detail-value"><Status value={activeLetter.status} /></div></div>
                  <Detail label="Absence dates" value={dateRange(activeLetter)} />
                  <Detail label="Submitted" value={formatDateTime(deanDetail.submitted_at)} />
                  <div className="detail-full"><div className="detail-label">Reason</div><div className="detail-value">{deanDetail.reason}</div></div>
                </div>}
                {deanDetail && <section className="student-evidence">
                  <div className="student-evidence-heading"><h3>Evidence</h3></div>
                  {deanDetail.evidence.length === 0 && <p className="field-hint">No evidence has been uploaded for this letter.</p>}
                  {deanDetail.evidence.length > 0 && <ul className="student-evidence-list">{deanDetail.evidence.map((item) => (
                    <li key={item.id}>
                      <div><strong>{item.original_filename}</strong><small>{item.mime_type} · {(item.size_bytes / 1024 / 1024).toFixed(2)} MB · Uploaded {formatDateTime(item.uploaded_at)}</small></div>
                      {deanEvidenceLinks[item.id]
                        ? <div className="student-evidence-actions"><a className="secondary evidence-open" href={deanEvidenceLinks[item.id]} target="_blank" rel="noopener noreferrer">Open private file</a><button className="review-link" type="button" onClick={() => prepareDeanEvidenceLink(item.id)}>Get new link</button></div>
                        : <button className="secondary" type="button" disabled={deanEvidenceLinkLoading === item.id} onClick={() => prepareDeanEvidenceLink(item.id)}>{deanEvidenceLinkLoading === item.id ? 'Preparing…' : 'Get secure link'}</button>}
                    </li>
                  ))}</ul>}
                </section>}
                {deanDetail && <section className="status-history"><h3>Status history</h3>{deanDetail.statusEvents.length
                  ? <ol>{deanDetail.statusEvents.map((event) => <li key={event.id}><strong>{event.old_status} → {event.new_status}</strong><time>{formatDateTime(event.created_at)}</time>{event.comment && <p>{event.comment}</p>}</li>)}</ol>
                  : <p>No status changes have been recorded yet.</p>}</section>}
                {deanDetail && <div className="qr-center"><QRCode letterId={deanDetail.id} /></div>}
                {deanDecisionError && <p className="student-data-error" role="alert">{deanDecisionError}</p>}
                {deanDecisionSuccess && <p className="student-evidence-success" role="status">{deanDecisionSuccess}</p>}
                {deanDetail && deanNotificationStates[deanDetail.id] && (
                  <p
                    className={deanNotificationStates[deanDetail.id].status === 'failed' ? 'student-data-error' : 'student-evidence-success'}
                    role={deanNotificationStates[deanDetail.id].status === 'failed' ? 'alert' : 'status'}
                  >
                    {deanNotificationStates[deanDetail.id].message}
                  </p>
                )}
              </div>
              {deanDetail?.status === 'pending' && deanDetailStatus === 'ready'
                ? <div className="modal-actions dean-decision-actions">
                    <div className="comment-field"><label htmlFor="dean-decision-comment">Optional decision comment</label><textarea id="dean-decision-comment" placeholder="Add a note for the student" value={decisionComment} onChange={(event) => setDecisionComment(event.target.value)} disabled={deanDecisionBusy} /></div>
                    <div className="action-right"><button className="danger" onClick={() => decideDeanLetter('disapproved')} type="button" disabled={deanDecisionBusy}>{deanDecisionBusy ? 'Saving…' : 'Disapprove'}</button><button className="approve" onClick={() => decideDeanLetter('approved')} type="button" disabled={deanDecisionBusy}>{deanDecisionBusy ? 'Saving…' : 'Approve'}</button></div>
                  </div>
                : <div className="modal-actions"><button className="secondary" onClick={closeLetter} type="button">Close</button><span className="modal-hint">{deanDetail?.status === 'pending' ? 'Decision unavailable until details finish loading.' : 'This letter is no longer pending review.'}</span>{deanDetail && ['failed', 'not_sent', 'in_progress'].includes(deanNotificationStates[deanDetail.id]?.status) && <button className="secondary" onClick={retryDeanStudentNotification} type="button">{deanNotificationStates[deanDetail.id].status === 'not_sent' ? 'Send student email' : deanNotificationStates[deanDetail.id].status === 'in_progress' ? 'Check student email' : 'Retry student email'}</button>}</div>}
            </>
          ) : professorDetailOpen ? (
            <>
              <div className="modal-head"><div><h2 id="modal-title">Approved excuse letter</h2><p>{professorDetail ? `${professorDetail.id} · Submitted ${formatDate(professorDetail.submitted_at)}` : 'Loading approved letter details'}</p></div><button className="close" onClick={closeLetter} aria-label="Close" type="button">×</button></div>
              <div className="modal-content">
                {professorDetailStatus === 'loading' && <p className="student-detail-message" role="status">Loading approved letter details…</p>}
                {professorDetailStatus === 'error' && <p className="student-data-error" role="alert">{professorDetailError}</p>}
                {professorDetail && <>
                  <div className="detail-grid">
                    {professorStudentIdentityStatus === 'loading' && <p className="student-detail-message detail-full" role="status">Loading authorized student identity…</p>}
                    {professorStudentIdentityStatus === 'ready' && professorStudentIdentity && <>
                      <Detail label="Student name" value={professorStudentIdentity.full_name} />
                      <Detail label="Student number" value={professorStudentIdentity.student_number} />
                    </>}
                    {professorStudentIdentityStatus === 'ready' && !professorStudentIdentity && <p className="field-hint detail-full">Student identity is unavailable for this letter.</p>}
                    {professorStudentIdentityStatus === 'error' && <div className="detail-full">
                      <p className="student-data-error" role="alert">Student identity could not be loaded: {professorStudentIdentityError}</p>
                      <button className="secondary" type="button" onClick={retryProfessorStudentIdentity}>Retry identity lookup</button>
                    </div>}
                    <Detail label="Course / section" value={activeLetter?.course} />
                    <div><div className="detail-label">Status</div><div className="detail-value"><Status value="Approved" /></div></div>
                    <Detail label="Absence dates" value={dateRange(activeLetter)} />
                    <Detail label="Approval date" value={formatDateTime(professorDetail.decided_at)} />
                    <div className="detail-full"><div className="detail-label">Reason for absence</div><div className="detail-value">{professorDetail.reason}</div></div>
                  </div>
                  <section className="student-evidence">
                    <div className="student-evidence-heading"><h3>Supporting evidence</h3><button className="secondary" type="button" onClick={refreshProfessorEvidence} disabled={professorEvidenceStatus === 'loading'}>Refresh</button></div>
                    {professorEvidenceStatus === 'loading' && <p className="student-detail-message" role="status">Loading authorized evidence…</p>}
                    {professorEvidenceStatus === 'error' && <><p className="student-data-error" role="alert">Evidence could not be loaded: {professorEvidenceError}</p><button className="secondary" type="button" onClick={refreshProfessorEvidence}>Retry evidence access</button></>}
                    {professorEvidenceStatus === 'ready' && professorEvidence.length === 0 && <p className="field-hint">No evidence has been uploaded for this letter.</p>}
                    {professorEvidenceStatus === 'ready' && professorEvidence.length > 0 && <ul className="student-evidence-list">{professorEvidence.map((item) => (
                      <li key={item.id}>
                        <div><strong>{item.original_filename}</strong><small>{item.mime_type} · {(item.size_bytes / 1024 / 1024).toFixed(2)} MB · Uploaded {formatDateTime(item.uploaded_at)}</small></div>
                        {professorEvidenceLinks[item.id]
                          ? <div className="student-evidence-actions"><a className="secondary evidence-open" href={professorEvidenceLinks[item.id]} target="_blank" rel="noopener noreferrer">Open private file</a><button className="review-link" type="button" onClick={() => prepareProfessorEvidenceLink(item.id)}>Get new link</button></div>
                          : <button className="secondary" type="button" disabled={professorEvidenceLinkLoading === item.id} onClick={() => prepareProfessorEvidenceLink(item.id)}>{professorEvidenceLinkLoading === item.id ? 'Preparing…' : 'Get secure link'}</button>}
                      </li>
                    ))}</ul>}
                    {professorEvidenceLinkError && <p className="student-data-error" role="alert">Could not prepare a secure evidence link: {professorEvidenceLinkError}</p>}
                  </section>
                </>}
              </div>
              <div className="modal-actions"><button className="secondary" onClick={closeLetter} type="button">Close</button><span className="modal-hint">Read-only view. Decisions remain with the Dean.</span></div>
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

              </div>
              <div className="modal-actions"><button className="secondary" onClick={closeLetter} type="button">Close</button><span className="modal-hint">{activeLetter.status === 'Approved' ? 'Visible to assigned professor' : activeLetter.status === 'Pending' ? 'Awaiting Dean review' : 'See the comment above for next steps'}</span></div>
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
