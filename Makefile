# Outcrop's StartOS package: build orchestration.
#
# One s9pk per architecture (their hardware requirements differ), from the startos/ TypeScript tree and the Dockerfile,
# packed by start-cli for StartOS 0.4.2.1 and later.  They are signed with the packaging workspace's key
# (start-cli's developer key there: the key StartOS users already trust for paulscode packages).
#
#   make test-builds      fast build of $(TEST_ARCH)       -> builds/<version>/outcrop_<arch>-040.s9pk + SHA256SUMS
#   make release-builds   every architecture, clean tree -> builds/<version>/outcrop_<arch>-040.s9pk + SHA256SUMS
#   make verify-040       check the built s9pks (version, OS floor, architecture, GPU access, signer)
#   make install-test     sideload the $(TEST_ARCH) build to $(HOST)
#   (TEST_ARCH=aarch64 HOST=YOUR-SERVER.local for the GB10)
#   make release-publish  after SHA256SUMS.asc is in builds/<version>/: the GitHub release, then the registry
#
# The Ubuntu install does not use any of this (./setup.sh).

START_CLI ?= start-cli-2.8.0
HOST ?= YOUR-SERVER.local
TEST_ARCH ?= x86_64
# the architectures a release carries: aarch64 (the GB10) joins once its image and profile are done
RELEASE_ARCHES ?= x86_64
# the public key every paulscode package is signed with (what users add to StartOS's trusted keys)
TRUSTED_KEY := MCowBQYDK2VwAyEAqmnGEsDpAPlm2/mmxkbl6dE/PRN58tWVGYREBr0c//8=
REGISTRY_DIR ?= $(HOME)/workspace/start9-store/start9-040

PKG_ID := $(shell sed -n "s/^  id: '\([a-z0-9-]*\)',$$/\1/p" startos/manifest/index.ts)
# the release version: the version graph's `current` entry, v_0_1_0_0 -> 0.1.0.0
PKG_VERSION := $(shell sed -n 's/^  current: v_\([0-9_]*\),$$/\1/p' startos/versions/index.ts | tr _ .)
# Refuse to run with either unresolved: the build targets `rm -rf $(BUILD_DIR)`, and an empty version would make that
# the whole builds/ folder of signed releases.
ifeq ($(PKG_ID),)
$(error could not read the package id from startos/manifest/index.ts)
endif
ifeq ($(shell echo '$(PKG_VERSION)' | grep -Ex '[0-9]+(\.[0-9]+){3}'),)
$(error could not read the current version from startos/versions/index.ts (got "$(PKG_VERSION)"))
endif
BUILD_DIR := builds/$(PKG_VERSION)
SDK_DIR := node_modules/@start9labs/start-sdk
# node as the shell finds it: make's own PATH search stops at a directory named node (an SDK's, say) and fails
NODE := $(shell command -v node)
PRETTIER_CONFIG := $(SDK_DIR)/prettier.config.json

.DELETE_ON_ERROR:
.PHONY: check format test-builds release-builds verify-040 install-test release-publish clean-builds icons

node_modules: package-lock.json
	npm ci

package-lock.json: package.json
	npm i

# The startos/ tree bundled into the one JavaScript file start-cli evaluates, behind the SDK's own gate: type check, its
# lint rules, and prettier.
javascript/index.js: $(shell find startos -type f) tsconfig.json package.json node_modules
	npx tsc --noEmit
	$(NODE) $(SDK_DIR)/lint.mjs
	npx prettier --config $(PRETTIER_CONFIG) --check startos
	rm -rf javascript && npx ncc build startos/index.ts -o javascript

check: javascript/index.js

format: | node_modules
	npx prettier --config $(PRETTIER_CONFIG) --write startos

# pack ARCH: one architecture's s9pk into $(BUILD_DIR) (start-cli builds the image from the Dockerfile itself)
define pack
	ARCH=$(1) $(START_CLI) s9pk pack --arch=$(1) --icon icon.png -o $(BUILD_DIR)/$(PKG_ID)_$(1)-040.s9pk

endef

test-builds: javascript/index.js
	mkdir -p $(BUILD_DIR)
	rm -f $(BUILD_DIR)/$(PKG_ID)_$(TEST_ARCH)-040.s9pk $(BUILD_DIR)/SHA256SUMS*
	$(call pack,$(TEST_ARCH))
	cd $(BUILD_DIR) && sha256sum *.s9pk > SHA256SUMS
	@echo; echo "Test build ($(TEST_ARCH)) in $(BUILD_DIR):"; ls -lh $(BUILD_DIR); cat $(BUILD_DIR)/SHA256SUMS

release-builds: javascript/index.js
	@git diff --quiet && git diff --cached --quiet || { echo "the tree has uncommitted changes: commit them first (the s9pk records the commit)"; exit 1; }
	rm -rf $(BUILD_DIR)
	mkdir -p $(BUILD_DIR)
	$(foreach a,$(RELEASE_ARCHES),$(call pack,$(a)))
	cd $(BUILD_DIR) && sha256sum *.s9pk > SHA256SUMS
	@$(MAKE) --no-print-directory verify-040
	@echo; echo "Release build in $(BUILD_DIR): sign SHA256SUMS (SHA256SUMS.asc), then make release-publish"
	@ls -lh $(BUILD_DIR); cat $(BUILD_DIR)/SHA256SUMS

# what every s9pk's manifest must say ($$v: the version from startos/versions)
MANIFEST_CHECK := .id == "$(PKG_ID)" and .osVersion == "0.4.2.1" and .hardwareAcceleration and .images.main.nvidiaContainer and ((.version | gsub(":"; ".")) == $$v)

verify-040:
	@for f in $(BUILD_DIR)/*.s9pk; do \
	  m=$$($(START_CLI) s9pk inspect $$f manifest) || exit 1; \
	  echo "$$m" | jq -e --arg v "$(PKG_VERSION)" '$(MANIFEST_CHECK)' > /dev/null || { echo "$$f: manifest check failed"; exit 1; }; \
	  echo "$$m" | jq -e '.gitHash | test("-modified$$") | not' > /dev/null || echo "$$f: WARNING: built from a modified tree"; \
	  python3 -c 'import base64, sys; k = base64.b64decode(sys.argv[2])[-32:]; sys.exit(0 if k in open(sys.argv[1], "rb").read(4096) else 1)' \
	    $$f "$(TRUSTED_KEY)" || { echo "$$f: not signed with the trusted key"; exit 1; }; \
	  echo "$$f: $$(echo "$$m" | jq -r '"\(.version), \(.images.main.arch | join(",")), osVersion \(.osVersion)"'), signed with the trusted key"; \
	done

install-test:
	scp -q $(BUILD_DIR)/$(PKG_ID)_$(TEST_ARCH)-040.s9pk start9@$(HOST):/tmp/$(PKG_ID).s9pk
	ssh start9@$(HOST) 'sudo -n start-cli package install -s /tmp/$(PKG_ID).s9pk && rm -f /tmp/$(PKG_ID).s9pk'

# Only once SHA256SUMS.asc (signed on the airgapped machine) is in $(BUILD_DIR) and checks out.
release-publish:
	@test -f $(BUILD_DIR)/SHA256SUMS.asc || { echo "no $(BUILD_DIR)/SHA256SUMS.asc yet"; exit 1; }
	gpg --verify $(BUILD_DIR)/SHA256SUMS.asc $(BUILD_DIR)/SHA256SUMS
	cd $(BUILD_DIR) && sha256sum -c SHA256SUMS
	gh release create v$(PKG_VERSION) --title "Outcrop $(PKG_VERSION)" --notes-file $(BUILD_DIR)/RELEASE-NOTES.md \
	  $(BUILD_DIR)/*.s9pk $(BUILD_DIR)/SHA256SUMS $(BUILD_DIR)/SHA256SUMS.asc
	$(MAKE) -C $(REGISTRY_DIR) bump PKG=$(CURDIR)/builds

clean-builds:
	rm -rf javascript

icons: assets/icon-master.png
	convert assets/icon-master.png -resize 192x192 -strip -define png:compression-level=9 icon.png
	@sz=$$(stat -c '%s' icon.png); echo "icon.png = $$sz bytes (limit 40960)"; [ "$$sz" -le 40960 ]
