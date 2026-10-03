BIN := "node_modules/.bin"
EXTDIR := "$HOME/.pi/agent/extensions/shake"

install:
	rm -f ~/.pi/agent/extensions/shake.ts
	rm -rf {{EXTDIR}}
	mkdir -p {{EXTDIR}}/src
	cp index.ts package.json {{EXTDIR}}/
	cp src/*.ts {{EXTDIR}}/src/

uninstall:
	rm -rf {{EXTDIR}}
	rm -f ~/.pi/agent/extensions/shake.ts

check: typecheck test lint format-check package-check

typecheck:
	{{BIN}}/tsc -p tsconfig.json

test:
	bun test

lint:
	{{BIN}}/oxlint

format:
	{{BIN}}/oxfmt index.ts src test

format-check:
	{{BIN}}/oxfmt --check index.ts src test

package-check:
	bunx publint

coverage:
	bun test --coverage

clean:
	rm -rf node_modules