import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './common/decorators';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Always 200 — this is the container's own liveness probe (see DEPLOY.md).
   * A false restart over a one-off Redis blip is worse than staying up with
   * a stale-for-a-few-seconds `degraded` body, so the status code never
   * reflects `checks`. Anything that needs a real failure signal from the
   * status code alone (an external uptime monitor, not the orchestrator)
   * should poll `health/strict` instead.
   */
  @Public()
  @Get('health')
  health() {
    return this.appService.health();
  }

  /**
   * Same checks as `health`, but degraded now means 503 — for an external
   * monitor that alerts on status code and never reads the response body.
   * Never point the container's own healthcheck at this route: see the
   * comment on `health` above for why.
   */
  @Public()
  @Get('health/strict')
  async strictHealth() {
    const result = await this.appService.health();
    if (result.status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }
}
