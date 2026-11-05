/**
 * What sessions.ts says to agents (dialects, HI-2065; card 3b, HI-2436): the file lock's replies and go-aheads, the
 * prompt after a sign-in, a hand-over's deliveries, and the launch record's and stored names' text. Agent messages,
 * kept beside sessions.ts as the Agent API's are beside servers.ts (apiText.ts). Ids are `session.<name>` or
 * `session.<group>.<name>`, the table's path.
 */
import { agentMsg } from '../shared/agentText'

export const SESSION = {
  carryOn: agentMsg({ id: 'session.carryOn', text: 'Your last turn stopped because your sign-in had expired. It is renewed now: carry on where you left off.', note: 'What Resume types into an agent whose turn stopped while its sign-in had expired.' }),
  skillNotGiven: agentMsg({ id: 'session.skillNotGiven', text: 'nobody gets it: {why}', note: "A skill not delivered at a launch, in the launch record the Agent API's project status shows (stored)." }),
  adopted: agentMsg({ id: 'session.adopted', text: 'Adopted session {id}', note: 'The stored name of a session Combwork adopted that has no title (its id, cut): agents read it and the user can rename it.' }),
  handover: {
    ask: agentMsg({
      id: 'session.handover.ask',
      text: 'Please write a handover of this work with the cw_create_handover tool, so that {self, select, yes {you can continue it in a new conversation} other {another agent ({to}) can continue it}}: the goal, what is done, decisions made and why, the current state, open problems and the next steps. Then stop.',
      note: 'The delivery asking an agent for a handover, before its work is handed to another agent ({to}) or to itself in a new conversation (#1057).'
    }),
    read: agentMsg({
      id: 'session.handover.read',
      text: 'Read the handover "{handover}" with the cw_read_shared_note tool and continue the work from it. It was written by {self, select, yes {you, in your previous conversation} other {{from}}}.',
      note: "The delivery giving an agent the handover it continues from: another agent's ({from}), or its own."
    })
  },
  lock: {
    anotherAgent: agentMsg({ id: 'session.lock.anotherAgent', text: 'Another agent', note: "The file lock's holder, when it has no name." }),
    warn: agentMsg({ id: 'session.lock.warn', text: "Note: {holder} is also editing {file} right now. Check the file's current content before changing it, and keep your edit small.", note: "The file lock's note with an edit it lets through (warn mode)." }),
    asked: agentMsg({
      id: 'session.lock.asked',
      text: "{holder} is editing {file} right now (Combwork file lock). Combwork has asked the user whether you may edit it too. Stop and wait: don't work around this. When the user says go ahead, try the edit again.",
      note: "The file lock's refusal while it asks the user whether the agent may edit the file too."
    }),
    blocked: agentMsg({
      id: 'session.lock.blocked',
      text: '{holder} is editing {file} right now (Combwork file lock). Work on something else, or wait until {holder} has finished its task, then try again.',
      note: "The file lock's refusal, or its CLI's own question (ask mode)."
    }),
    goAhead: agentMsg({
      id: 'session.lock.goAhead',
      text: 'The user allowed you to edit {files} while the other agent works on {count, plural, one {it} other {them}}. Go ahead with the {count, plural, one {edit} other {edits}}.',
      note: 'Typed to an agent once its turn ends: the user allowed its locked edits.'
    }),
    claimEnded: agentMsg({
      id: 'session.lock.claimEnded',
      text: 'The other agent has finished with {files}, so Combwork no longer asks the user about {count, plural, one {it} other {them}}. Try the {count, plural, one {edit} other {edits}} again.',
      note: 'Typed to an agent once its turn ends: the claim its edits waited on has ended (HI-2386).'
    }),
    goAheadDropped: agentMsg({ id: 'session.lock.goAheadDropped', text: 'cancelled: the go-ahead was dropped', note: "Why a go-ahead's delivery was cancelled, in its record (stored)." })
  }
}
