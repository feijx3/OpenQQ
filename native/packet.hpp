#pragma once
#include "bootstrap.hpp"

// Publish the built-in JS packet API; hooks are initialized lazily after login.
void InstallPacketBridge(void *env, HMODULE runtime, AddonInit original, void *global);
