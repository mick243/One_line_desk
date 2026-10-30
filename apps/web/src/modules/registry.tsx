import { ConnectedApps, ConsentScreen, LinkEntry } from './mcp';
import { ChartScreen, InquiryInbox, InquirySheet, LeaveRequestSheet, MyInquiries, WrongSheet } from './navi';
import { BoardScreen, MyRequests, OpsScreen, pantryCardRenderers } from './pantry';
import { DemoInbox, InvitedMeetings, InviteSheet, MyLoans, MyReservations, RoomChat, RoomDirectory, roomsCardRenderers } from './rooms';
import type { WebModules } from './types';

// 모듈 화면 부품 목록. 공통 화면은 여기서만 꺼내 써요.
export const webModules: WebModules = {
  cardRenderers: { ...pantryCardRenderers, ...roomsCardRenderers },
  WrongSheet,
  InquirySheet,
  LeaveRequestSheet,
  InquiryInbox,
  MyInquiries,
  BoardScreen,
  OpsScreen,
  ChartScreen,
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
