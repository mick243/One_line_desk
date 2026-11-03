import { lazyPart } from '../components/LazyPart';
import { ConnectedApps } from './mcp';
import { InquiryInbox, InquirySheet, MyInquiries } from './navi';
import { BoardScreen, MyRequests, pantryCardRenderers } from './pantry';
import { DemoInbox, InvitedMeetings, InviteSheet, MyLoans, MyReservations, RoomChat, RoomDirectory, roomsCardRenderers } from './rooms';
import type { WebModules } from './types';

// 역할이 있는 사람이나 바깥 주소로 들어온 사람만 보는 화면은 처음 열 때 따로 불러요(첫 화면 JS를 줄여요).
// 이 화면들을 모듈 index에서 다시 내보내거나 여기서 바로 import하면 첫 화면에 같이 묶여요.
// cardRenderers는 CardView와 서로 불러서 바로 불러요.
const OpsScreen = lazyPart(() => import('./pantry/OpsScreen').then((m) => m.OpsScreen));
const ChartScreen = lazyPart(() => import('./navi/ChartScreen').then((m) => m.ChartScreen));
const ItHelpScreen = lazyPart(() => import('./navi/ItHelpScreen').then((m) => m.ItHelpScreen));
const OnboardingScreen = lazyPart(() => import('./navi/OnboardingScreen').then((m) => m.OnboardingScreen));
const LeaveRequestSheet = lazyPart(() => import('./navi/LeaveRequestSheet').then((m) => m.LeaveRequestSheet));
const ConsentScreen = lazyPart(() => import('./mcp/entry').then((m) => m.ConsentScreen));
const LinkEntry = lazyPart(() => import('./mcp/entry').then((m) => m.LinkEntry));

// 모듈 화면 부품 목록. 공통 화면은 여기서만 꺼내 써요.
export const webModules: WebModules = {
  cardRenderers: { ...pantryCardRenderers, ...roomsCardRenderers },
  InquirySheet,
  LeaveRequestSheet,
  InquiryInbox,
  MyInquiries,
  BoardScreen,
  OpsScreen,
  ChartScreen,
  ItHelpScreen,
  OnboardingScreen,
  MyReservations,
  MyLoans,
  RoomChat,
  RoomDirectory,
  InviteSheet,
  InvitedMeetings,
  DemoInbox,
  MyRequests,
  ConnectedApps,
  ConsentScreen,
  LinkEntry,
};

export const cardRenderers = webModules.cardRenderers;
