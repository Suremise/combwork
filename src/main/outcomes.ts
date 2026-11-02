import { msg } from '../shared/i18n'

/**
 * What a notification says once its buttons' action is done or no longer applies (HI-2320, Darren: "once the action is
 * done or no longer needed it goes, and the entry says what happened"): shown in place of its buttons, in its pop-up and
 * its row under the bell. Short, in the language Hive shows.
 */
export const OUTCOME = {
  conversationEnded: msg({ id: 'main.outcome.conversationEnded', defaultMessage: 'Its conversation ended', description: "What a notification about an agent's conversation (a long conversation's Hand Over to…) says once that conversation's session has ended (HI-2320), in place of its button." }),
  conversationMoved: msg({ id: 'main.outcome.conversationMoved', defaultMessage: 'It has a new conversation now', description: "What the long-conversation notification says once the agent has moved to a new conversation (handed over, or the CLI started one; HI-2320), in place of its Hand Over to… button." }),
  openHereAgain: msg({ id: 'main.outcome.openHereAgain', defaultMessage: 'The conversation is open here again', description: "What the notice that a conversation runs as a background job says once it is open in Hive again (HI-2320), in place of its Stop It and Resume button." }),
  runsAnother: msg({ id: 'main.outcome.runsAnother', defaultMessage: 'It runs another conversation here now', description: "What the notice that a conversation runs as a background job says once the agent runs another conversation in Hive (HI-2320), in place of its Stop It and Resume button." }),
  stoppedAndResumed: msg({ id: 'main.outcome.stoppedAndResumed', defaultMessage: 'Stopped and resumed here', description: "What the notice that a conversation runs as a background job says after Stop It and Resume (HI-2320), in place of its button." }),
  allowed: msg({ id: 'main.outcome.allowed', defaultMessage: 'Allowed', description: "What the notice that an agent wants to edit a file another agent is editing says after Allow (HI-2320), in place of its button. Keep it short." }),
  noLongerAsked: msg({ id: 'main.outcome.noLongerAsked', defaultMessage: 'No longer asked', description: "What the notice that an agent wants to edit a locked file says once the agent no longer asks (its turn ended, or it was allowed elsewhere; HI-2320), in place of its Allow button." }),
  modesNextSession: msg({ id: 'main.outcome.modesNextSession', defaultMessage: 'Their sessions ended: the new mode applies from the next', description: "What the notice that the permission mode changed says once none of the agents it named still runs that session (HI-2320), in place of its Switch Now button." }),
  modesAlready: msg({ id: 'main.outcome.modesAlready', defaultMessage: 'Switched: the agents are in their new mode', description: "What the notice that the permission mode changed says once every agent it named is in its new mode, switched there or by hand (HI-2320), in place of its Switch Now button." }),
  handOverLater: msg({ id: 'main.outcome.handOverLater', defaultMessage: 'Not now: Hand Over to… is in its ⋯ menu once it is free', description: "What the long-conversation notification says once the agent may no longer hand over from it (it works again, or is on a card loop's card; HI-2320), in place of its Hand Over to… button. Hand Over to… is a command; the ⋯ menu is on the agent's pane." }),
  modesNothing: msg({ id: 'main.outcome.modesNothing', defaultMessage: 'Nothing to switch: every running agent is in its mode', description: "What the notice that the permission mode changed says after Switch Now found nothing to switch (HI-2320), in place of its button." }),
  released: msg({ id: 'main.outcome.released', defaultMessage: 'Released', description: "What the notice that a slot is held by Windows' idle Sandbox broker says once the slot is released (HI-2320), in place of its Release Slot… button. Keep it short." }),
  noLongerHeld: msg({ id: 'main.outcome.noLongerHeld', defaultMessage: 'No longer held', description: "What the notice that a slot is held by Windows' idle Sandbox broker says once nothing holds it (HI-2320), in place of its Release Slot… button." }),
  namesDiffer: msg({ id: 'main.outcome.namesDiffer', defaultMessage: 'The names differ now', description: "What the notice that agents share a name says once they no longer do (HI-2320), in place of its Rename… button." }),
  notReady: msg({ id: 'main.outcome.updateNotReady', defaultMessage: 'No longer ready to install', description: "What the notice that a Hive update is ready says once that update is no longer the one ready (HI-2320), in place of its Restart and Update button." }),
  installing: msg({ id: 'main.outcome.updateInstalling', defaultMessage: 'Installing: Hive restarts', description: "What the notice that a Hive update is ready says after Restart and Update (HI-2320), in place of its button, as Hive restarts to install it." }),
  notResumed: msg({ id: 'main.outcome.notResumed', defaultMessage: 'Not resumed', description: "What the notice offering to resume the agents that were working before Hive restarted says after Don't Resume (HI-2320), in place of its buttons." })
}
