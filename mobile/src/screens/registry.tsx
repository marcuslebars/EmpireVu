import { Automations } from "@m/screens/automation/Automations";
import { Builder } from "@m/screens/automation/Builder";
import { Ops } from "@m/screens/automation/Ops";
import { Run } from "@m/screens/automation/Run";
import { Calendar } from "@m/screens/calendar/Calendar";
import { Booking } from "@m/screens/calendar/Booking";
import { Photos } from "@m/screens/calendar/Photos";
import { NewBooking, NewContact, NewTask } from "@m/screens/create/CreateForms";
import { Contact } from "@m/screens/crm/Contact";
import { Crm } from "@m/screens/crm/Crm";
import { Lead } from "@m/screens/crm/Lead";
import { Home } from "@m/screens/home/Home";
import { Inbox } from "@m/screens/inbox/Inbox";
import { More } from "@m/screens/more/More";
import { Notifications } from "@m/screens/more/Notifications";
import { Search } from "@m/screens/more/Search";
import { Quote } from "@m/screens/money/Quote";
import { Quotes } from "@m/screens/money/Quotes";
import { Appearance } from "@m/screens/settings/Appearance";
import { Billing } from "@m/screens/settings/Billing";
import { Integrations } from "@m/screens/settings/Integrations";
import { Members } from "@m/screens/settings/Members";
import { NotifPrefs } from "@m/screens/settings/NotifPrefs";
import { Organization } from "@m/screens/settings/Organization";
import { Payments } from "@m/screens/settings/Payments";
import { Settings } from "@m/screens/settings/Settings";
import { Call } from "@m/screens/system/Call";
import { Voice } from "@m/screens/system/Voice";
import { Task } from "@m/screens/tasks/Task";
import { Tasks } from "@m/screens/tasks/Tasks";
import type { Route, TabId } from "@m/state/nav";

export function renderTab(tab: TabId) {
  switch (tab) {
    case "home":
      return <Home />;
    case "inbox":
      return <Inbox />;
    case "calendar":
      return <Calendar />;
    case "tasks":
      return <Tasks />;
    case "more":
      return <More />;
  }
}

export function renderRoute(route: Route) {
  switch (route.name) {
    case "lead":
      return <Lead contactId={route.contactId} />;
    case "contact":
      return <Contact contactId={route.contactId} />;
    case "booking":
      return <Booking bookingId={route.bookingId} />;
    case "task":
      return <Task taskId={route.taskId} />;
    case "crm":
      return <Crm />;
    case "quotes":
      return <Quotes />;
    case "quote":
      return <Quote quoteId={route.quoteId} contactId={route.contactId} />;
    case "automations":
      return <Automations />;
    case "run":
      return <Run runId={route.runId} />;
    case "builder":
      return <Builder />;
    case "settings":
      return <Settings />;
    case "voice":
      return <Voice />;
    case "call":
      return <Call contactId={route.contactId} phone={route.phone} calleeName={route.calleeName} />;
    case "photos":
      return <Photos bookingId={route.bookingId} />;
    case "search":
      return <Search />;
    case "notifications":
      return <Notifications />;
    case "newContact":
      return <NewContact />;
    case "newBooking":
      return <NewBooking contactId={route.contactId} />;
    case "newTask":
      return <NewTask contactId={route.contactId} bookingId={route.bookingId} title={route.title} />;
    case "org":
      return <Organization />;
    case "members":
      return <Members />;
    case "billing":
      return <Billing />;
    case "payments":
      return <Payments />;
    case "notifPrefs":
      return <NotifPrefs />;
    case "integrations":
      return <Integrations />;
    case "appearance":
      return <Appearance />;
    case "ops":
      return <Ops />;
  }
}

export function routeKey(route: Route): string {
  return JSON.stringify(route);
}
