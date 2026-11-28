# What `availability` decides

Written by availability.test.ts (UPDATE_GOLDEN=1). `yes`, or the code of the rule that refuses. A session here has
no repository; every other kind of work has one.

## Hosted, ChatGPT plan, OpenAI and Anthropic keys and plans

| session | Hosted Strict (e2b) | Hosted Open (e2b-open) | Hosted Open (daytona) |
| --- | --- | --- | --- |
| windlass | yes | yes | yes |
| claude | agent_needs_isolation | yes | yes |
| opencode | agent_needs_isolation | yes | yes |
| codex | agent_needs_isolation | yes | yes |

| quick | Hosted Strict (e2b) | Hosted Open (e2b-open) | Hosted Open (daytona) |
| --- | --- | --- | --- |
| windlass | yes | yes | yes |
| claude | agent_needs_isolation | yes | yes |
| opencode | agent_needs_isolation | yes | yes |
| codex | agent_needs_isolation | yes | yes |

| part | Hosted Strict (e2b) | Hosted Open (e2b-open) | Hosted Open (daytona) |
| --- | --- | --- | --- |
| windlass | yes | yes | yes |
| claude | agent_needs_isolation | yes | yes |
| opencode | agent_needs_isolation | yes | yes |
| codex | agent_quick_only | agent_quick_only | agent_quick_only |

| planner | Hosted Strict (e2b) | Hosted Open (e2b-open) | Hosted Open (daytona) |
| --- | --- | --- | --- |
| windlass | yes | yes | yes |
| claude | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| opencode | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| codex | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |

## Hosted, ChatGPT plan only

| session | Hosted Strict (e2b) | Hosted Open (e2b-open) | Hosted Open (daytona) |
| --- | --- | --- | --- |
| windlass | yes | yes | yes |
| claude | agent_needs_isolation | nothing_pays | nothing_pays |
| opencode | agent_needs_isolation | nothing_pays | nothing_pays |
| codex | agent_needs_isolation | nothing_pays | nothing_pays |

| quick | Hosted Strict (e2b) | Hosted Open (e2b-open) | Hosted Open (daytona) |
| --- | --- | --- | --- |
| windlass | yes | yes | yes |
| claude | agent_needs_isolation | nothing_pays | nothing_pays |
| opencode | agent_needs_isolation | nothing_pays | nothing_pays |
| codex | agent_needs_isolation | nothing_pays | nothing_pays |

| part | Hosted Strict (e2b) | Hosted Open (e2b-open) | Hosted Open (daytona) |
| --- | --- | --- | --- |
| windlass | yes | yes | yes |
| claude | agent_needs_isolation | nothing_pays | nothing_pays |
| opencode | agent_needs_isolation | nothing_pays | nothing_pays |
| codex | agent_quick_only | agent_quick_only | agent_quick_only |

| planner | Hosted Strict (e2b) | Hosted Open (e2b-open) | Hosted Open (daytona) |
| --- | --- | --- | --- |
| windlass | yes | yes | yes |
| claude | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| opencode | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| codex | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |

## Hosted where no profile can use plans or keys, keys only

| session | Hosted Strict (e2b) | Hosted Open (e2b-open) |
| --- | --- | --- |
| windlass | yes | yes |
| claude | agent_needs_isolation | no_relay |
| opencode | agent_needs_isolation | no_relay |
| codex | agent_needs_isolation | no_relay |

| quick | Hosted Strict (e2b) | Hosted Open (e2b-open) |
| --- | --- | --- |
| windlass | yes | yes |
| claude | agent_needs_isolation | no_relay |
| opencode | agent_needs_isolation | no_relay |
| codex | agent_needs_isolation | no_relay |

| part | Hosted Strict (e2b) | Hosted Open (e2b-open) |
| --- | --- | --- |
| windlass | yes | yes |
| claude | agent_needs_isolation | no_relay |
| opencode | agent_needs_isolation | no_relay |
| codex | agent_quick_only | agent_quick_only |

| planner | Hosted Strict (e2b) | Hosted Open (e2b-open) |
| --- | --- | --- |
| windlass | yes | yes |
| claude | role_is_windlass_only | role_is_windlass_only |
| opencode | role_is_windlass_only | role_is_windlass_only |
| codex | role_is_windlass_only | role_is_windlass_only |

## Machines: ready; owner has not allowed Strict

| session | ready Strict | ready Open | strict-denied Strict | strict-denied Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | profile_not_allowed | yes |
| claude | agent_needs_isolation | yes | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | yes | agent_needs_isolation | yes |
| codex | yes | yes | profile_not_allowed | yes |

| quick | ready Strict | ready Open | strict-denied Strict | strict-denied Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | profile_not_allowed | yes |
| claude | agent_needs_isolation | yes | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | yes | agent_needs_isolation | yes |
| codex | yes | yes | profile_not_allowed | yes |

| part | ready Strict | ready Open | strict-denied Strict | strict-denied Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | profile_not_allowed | yes |
| claude | agent_needs_isolation | yes | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | yes | agent_needs_isolation | yes |
| codex | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only |

| planner | ready Strict | ready Open | strict-denied Strict | strict-denied Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | profile_not_allowed | yes |
| claude | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| opencode | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| codex | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |

## Machines: Codex's sandbox not checked; no command sandbox; runner started without Claude Code

| session | codex-unchecked Strict | codex-unchecked Open | no-command-sandbox Strict | no-command-sandbox Open | no-claude Strict | no-claude Open |
| --- | --- | --- | --- | --- | --- | --- |
| windlass | yes | yes | profile_unavailable | yes | yes | yes |
| claude | agent_needs_isolation | yes | agent_needs_isolation | yes | machine_lacks_agent | machine_lacks_agent |
| opencode | agent_needs_isolation | yes | agent_needs_isolation | yes | agent_needs_isolation | yes |
| codex | sandbox_check_missing | yes | profile_unavailable | yes | yes | yes |

| quick | codex-unchecked Strict | codex-unchecked Open | no-command-sandbox Strict | no-command-sandbox Open | no-claude Strict | no-claude Open |
| --- | --- | --- | --- | --- | --- | --- |
| windlass | yes | yes | profile_unavailable | yes | yes | yes |
| claude | agent_needs_isolation | yes | agent_needs_isolation | yes | machine_lacks_agent | machine_lacks_agent |
| opencode | agent_needs_isolation | yes | agent_needs_isolation | yes | agent_needs_isolation | yes |
| codex | sandbox_check_missing | yes | profile_unavailable | yes | yes | yes |

| part | codex-unchecked Strict | codex-unchecked Open | no-command-sandbox Strict | no-command-sandbox Open | no-claude Strict | no-claude Open |
| --- | --- | --- | --- | --- | --- | --- |
| windlass | yes | yes | profile_unavailable | yes | yes | yes |
| claude | agent_needs_isolation | yes | agent_needs_isolation | yes | machine_lacks_agent | machine_lacks_agent |
| opencode | agent_needs_isolation | yes | agent_needs_isolation | yes | agent_needs_isolation | yes |
| codex | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only |

| planner | codex-unchecked Strict | codex-unchecked Open | no-command-sandbox Strict | no-command-sandbox Open | no-claude Strict | no-claude Open |
| --- | --- | --- | --- | --- | --- | --- |
| windlass | yes | yes | profile_unavailable | yes | yes | yes |
| claude | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| opencode | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| codex | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |

## Machines, agents signed out: nothing connected; keys; plans

| session | signed-out Strict | signed-out Open | signed-out-keys Strict | signed-out-keys Open | signed-out-plans Strict | signed-out-plans Open |
| --- | --- | --- | --- | --- | --- | --- |
| windlass | yes | yes | yes | yes | yes | yes |
| claude | agent_needs_isolation | yes | agent_needs_isolation | yes | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | yes | agent_needs_isolation | yes | agent_needs_isolation | yes |
| codex | yes | yes | yes | yes | yes | yes |

| quick | signed-out Strict | signed-out Open | signed-out-keys Strict | signed-out-keys Open | signed-out-plans Strict | signed-out-plans Open |
| --- | --- | --- | --- | --- | --- | --- |
| windlass | yes | yes | yes | yes | yes | yes |
| claude | agent_needs_isolation | nothing_pays | agent_needs_isolation | yes | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | not_signed_in | agent_needs_isolation | yes | agent_needs_isolation | not_signed_in |
| codex | nothing_pays | nothing_pays | yes | yes | yes | yes |

| part | signed-out Strict | signed-out Open | signed-out-keys Strict | signed-out-keys Open | signed-out-plans Strict | signed-out-plans Open |
| --- | --- | --- | --- | --- | --- | --- |
| windlass | yes | yes | yes | yes | yes | yes |
| claude | agent_needs_isolation | nothing_pays | agent_needs_isolation | yes | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | not_signed_in | agent_needs_isolation | yes | agent_needs_isolation | not_signed_in |
| codex | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only |

| planner | signed-out Strict | signed-out Open | signed-out-keys Strict | signed-out-keys Open | signed-out-plans Strict | signed-out-plans Open |
| --- | --- | --- | --- | --- | --- | --- |
| windlass | yes | yes | yes | yes | yes | yes |
| claude | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| opencode | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| codex | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |

## Machines: sign-in could not be checked; Codex signed in by a method the runner did not report

| session | sign-in-unknown Strict | sign-in-unknown Open | codex-method-unknown Strict | codex-method-unknown Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | yes | yes |
| claude | agent_needs_isolation | yes | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | yes | agent_needs_isolation | yes |
| codex | yes | yes | yes | yes |

| quick | sign-in-unknown Strict | sign-in-unknown Open | codex-method-unknown Strict | codex-method-unknown Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | yes | yes |
| claude | agent_needs_isolation | sign_in_unknown | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | sign_in_unknown | agent_needs_isolation | yes |
| codex | sign_in_unknown | sign_in_unknown | sign_in_method | sign_in_method |

| part | sign-in-unknown Strict | sign-in-unknown Open | codex-method-unknown Strict | codex-method-unknown Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | yes | yes |
| claude | agent_needs_isolation | sign_in_unknown | agent_needs_isolation | yes |
| opencode | agent_needs_isolation | sign_in_unknown | agent_needs_isolation | yes |
| codex | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only |

| planner | sign-in-unknown Strict | sign-in-unknown Open | codex-method-unknown Strict | codex-method-unknown Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | yes | yes |
| claude | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| opencode | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| codex | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |

## Machines: no network; runner too old

| session | no-network Strict | no-network Open | outdated Strict | outdated Open |
| --- | --- | --- | --- | --- |
| windlass | yes | yes | runner_outdated | runner_outdated |
| claude | agent_needs_isolation | yes | runner_outdated | runner_outdated |
| opencode | agent_needs_isolation | yes | runner_outdated | runner_outdated |
| codex | yes | yes | runner_outdated | runner_outdated |

| quick | no-network Strict | no-network Open | outdated Strict | outdated Open |
| --- | --- | --- | --- | --- |
| windlass | no_network_for_repo | no_network_for_repo | runner_outdated | runner_outdated |
| claude | agent_needs_isolation | no_network_for_repo | runner_outdated | runner_outdated |
| opencode | agent_needs_isolation | no_network_for_repo | runner_outdated | runner_outdated |
| codex | no_network_for_repo | no_network_for_repo | runner_outdated | runner_outdated |

| part | no-network Strict | no-network Open | outdated Strict | outdated Open |
| --- | --- | --- | --- | --- |
| windlass | no_network_for_repo | no_network_for_repo | runner_outdated | runner_outdated |
| claude | agent_needs_isolation | no_network_for_repo | runner_outdated | runner_outdated |
| opencode | agent_needs_isolation | no_network_for_repo | runner_outdated | runner_outdated |
| codex | agent_quick_only | agent_quick_only | agent_quick_only | agent_quick_only |

| planner | no-network Strict | no-network Open | outdated Strict | outdated Open |
| --- | --- | --- | --- | --- |
| windlass | no_network_for_repo | no_network_for_repo | runner_outdated | runner_outdated |
| claude | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| opencode | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |
| codex | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only | role_is_windlass_only |

## Notes on what is allowed

| agent | work | place | notes |
| --- | --- | --- | --- |
| windlass | session | Hosted Open | none |
| windlass | session | machine Open | none |
| windlass | session | machine Strict | none |
| windlass | quick | Hosted Open | none |
| windlass | quick | machine Open | none |
| windlass | quick | machine Strict | none |
| windlass | part | Hosted Open | none |
| windlass | part | machine Open | none |
| windlass | part | machine Strict | none |
| claude | session | Hosted Open | publish_asks_every_time, own_mcp_servers_not_passed |
| claude | session | machine Open | publish_asks_every_time, own_mcp_servers_not_passed |
| claude | quick | Hosted Open | works_without_asking, no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| claude | quick | machine Open | works_without_asking, no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| claude | part | Hosted Open | works_without_asking (confirm), no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| claude | part | machine Open | works_without_asking (confirm), no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| opencode | session | Hosted Open | publish_asks_every_time, own_mcp_servers_not_passed |
| opencode | session | machine Open | publish_asks_every_time, own_mcp_servers_not_passed |
| opencode | quick | Hosted Open | works_without_asking, no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| opencode | quick | machine Open | works_without_asking, no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| opencode | part | Hosted Open | works_without_asking (confirm), no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| opencode | part | machine Open | works_without_asking (confirm), no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| codex | session | Hosted Open | publish_asks_every_time, own_mcp_servers_not_passed |
| codex | session | machine Open | publish_asks_every_time, own_mcp_servers_not_passed |
| codex | session | machine Strict | publish_asks_every_time, checks_left_to_ci, own_mcp_servers_not_passed |
| codex | quick | Hosted Open | works_without_asking, no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| codex | quick | machine Open | works_without_asking, no_screenshots, publish_asks_every_time, own_mcp_servers_not_passed |
| codex | quick | machine Strict | leaving_sandbox_ends_step, no_screenshots, publish_asks_every_time, checks_left_to_ci, own_mcp_servers_not_passed |

## Profiles when none is named, the one taken first

| agent | work | Hosted | ready | strict-denied | codex-unchecked |
| --- | --- | --- | --- | --- | --- |
| windlass | session | e2b, e2b-open, daytona | docker-windlass-sandbox, docker-hardened | docker-hardened | docker-windlass-sandbox, docker-hardened |
| windlass | quick | e2b, e2b-open, daytona | docker-windlass-sandbox, docker-hardened | docker-hardened | docker-windlass-sandbox, docker-hardened |
| claude | session | e2b-open, daytona | docker-hardened | docker-hardened | docker-hardened |
| claude | quick | e2b-open, daytona | docker-hardened | docker-hardened | docker-hardened |
| opencode | session | e2b-open, daytona | docker-hardened | docker-hardened | docker-hardened |
| opencode | quick | e2b-open, daytona | docker-hardened | docker-hardened | docker-hardened |
| codex | session | e2b-open, daytona | docker-windlass-sandbox, docker-hardened | docker-hardened | docker-hardened |
| codex | quick | e2b-open, daytona | docker-windlass-sandbox, docker-hardened | docker-hardened | docker-hardened |
