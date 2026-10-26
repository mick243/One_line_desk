import type { AppContext } from '../context';
import type { DeskModule } from '../core/module';
import { createMcpModule } from './mcp';
import { createNaviModule } from './navi';
import { createNoticesModule } from './notices';
import { createPantryModule } from './pantry';
import { createRoomsModule } from './rooms';

/** 모듈 목록. 모듈 사이 기능은 각 팩토리가 ctx.services에 넣어서 주고받아요. */
export function createModules(ctx: AppContext): DeskModule[] {
  return [createNaviModule(ctx), createNoticesModule(ctx), createRoomsModule(ctx), createPantryModule(ctx), createMcpModule(ctx)];
}
